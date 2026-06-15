// services/estoque-audit.js
// Auditoria read-only de COBERTURA + ESTOQUE: cruza BW(ativo) x Shopify x Bling(saldo).
// Join pela SKU: referencia(BW) = codigo(Bling) = sku da variante(Shopify).
// O estoque vem do MESMO extrator que o sync usou pra popular a Shopify (processProduct.quantidade),
// entao a comparacao e "maca com maca": divergencia = mudanca real desde o ultimo sync.
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const blingProducts = require('./bling-products');
const shopifyProducts = require('./shopify-products');

const SHOP = process.env.SHOPIFY_SHOP;
const API_VER = '2026-04';
const REPORT_PATH = path.join(__dirname, '..', 'data', 'estoque-audit.json');

let _running = false;
let _report = freshReport();

// Estrutura inicial do relatorio
function freshReport() {
  return {
    status: 'idle', geradoEm: null, finishedAt: null,
    progresso: { blingPagina: 0, blingProdutosLidos: 0 },
    contagem: { bwAtivos: 0, blingSkus: 0, shopifySkus: 0 },
    resumo: { faltandoNaShopify: 0, estoqueDivergente: 0, estoqueOk: 0, semSaldoBling: 0, semBlingMatch: 0, foraDaBW: 0 },
    amostras: { faltando: [], divergente: [], semBlingMatch: [] }
  };
}

function saveReport() {
  const dir = path.dirname(REPORT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(_report, null, 2));
}
function loadReport() {
  try { return JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')); } catch (e) { return freshReport(); }
}

// Normaliza e grava sku -> quantidade no mapa ('' / null = saldo desconhecido)
function setQty(map, sku, qty) {
  const k = String(sku || '').trim();
  if (!k) return;
  const n = (qty === '' || qty === null || qty === undefined) ? null : Number(qty);
  map.set(k, (n === null || isNaN(n)) ? null : n);
}

// Le o catalogo inteiro da Bling e monta sku -> saldo, pulando filhas (processadas pelo pai),
// igual ao sync — garante o mesmo conjunto de SKUs que foi pra Shopify.
async function buildBlingStockMap() {
  const map = new Map();
  let page = 1;
  while (_running) {
    let products;
    try { products = (await blingProducts.fetchProductsPage(page, 100)).data || []; }
    catch (e) {
      if (e.response && e.response.status === 429) { logger.warning('Estoque-audit: Bling 429, aguardando 60s'); await blingProducts.sleep(60000); continue; }
      throw e;
    }
    if (!products.length) break;

    for (const p of products) {
      if (!_running) break;
      try {
        const details = await blingProducts.fetchProductDetails(p.id);
        await blingProducts.sleep(280); // respeita rate limit do Bling
        const codigoPai = details.codigoPai
          || (details.estrutura && details.estrutura.pai && details.estrutura.pai.id)
          || (details.variacao && details.variacao.produtoPai && details.variacao.produtoPai.id)
          || p.idProdutoPai || null;
        if (codigoPai) continue; // variacao-filha: o saldo dela sai do pai
        const processed = blingProducts.processProduct(p, details);
        if (processed.kit) continue; // kit nao tem saldo proprio comparavel
        if (processed.simple) setQty(map, processed.simple.sku, processed.simple.quantidade);
        for (const v of processed.variations) setQty(map, v.sku, v.quantidade);
      } catch (e) {
        logger.error(`Estoque-audit Bling produto ${p.id}: ${e.message}`);
      }
    }
    _report.progresso.blingPagina = page;
    _report.progresso.blingProdutosLidos = map.size;
    saveReport();
    page++;
    await blingProducts.sleep(400);
  }
  return map;
}

// Le todas as variantes da Shopify e monta sku -> { invQty, status }
async function buildShopifyStockMap() {
  const token = await shopifyProducts.getToken();
  const map = new Map();
  let cursor = null, has = true;
  const q = `query($c:String){ products(first:100, after:$c){ pageInfo{hasNextPage endCursor} nodes{ status variants(first:100){ nodes{ sku inventoryQuantity } } } } }`;
  while (has) {
    const r = await axios.post(
      `https://${SHOP}/admin/api/${API_VER}/graphql.json`,
      { query: q, variables: { c: cursor } },
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 40000 }
    );
    const d = r.data.data.products;
    for (const prod of d.nodes) {
      for (const v of prod.variants.nodes) {
        const k = String(v.sku || '').trim();
        if (k) map.set(k, { invQty: v.inventoryQuantity == null ? null : Number(v.inventoryQuantity), status: prod.status });
      }
    }
    has = d.pageInfo.hasNextPage; cursor = d.pageInfo.endCursor;
  }
  return map;
}

// Orquestra: BW(ativo) -> Bling(saldo) -> Shopify(invQty) -> compara
async function _run() {
  logger.info('=== AUDITORIA DE ESTOQUE: BW(ativo) x Shopify x Bling ===');

  const bw = await shopifyProducts.loadBwIndex();                         // ref -> { categoria, ativo, ... }
  const ativos = new Set(Object.entries(bw).filter(([, r]) => r.ativo).map(([ref]) => ref.trim()));
  _report.contagem.bwAtivos = ativos.size; saveReport();

  const bling = await buildBlingStockMap();                                // sku -> saldo (Bling)
  if (!_running) { _report.status = 'stopped'; saveReport(); logger.warning('Estoque-audit interrompido'); return; }
  _report.contagem.blingSkus = bling.size; saveReport();

  const shop = await buildShopifyStockMap();                               // sku -> { invQty, status }
  _report.contagem.shopifySkus = shop.size; saveReport();

  const faltando = [], divergente = [], semBlingMatch = [];
  let estoqueOk = 0, semSaldoBling = 0, foraDaBW = 0;

  // 1) Cobertura: ativo na BW mas ausente na Shopify
  for (const ref of ativos) if (!shop.has(ref)) faltando.push(ref);

  // 2) Estoque: cada sku da Shopify x saldo Bling
  for (const [sku, s] of shop) {
    const ativoBW = ativos.has(sku);
    if (!ativoBW) foraDaBW++;
    if (!bling.has(sku)) { semBlingMatch.push(sku); continue; }
    const b = bling.get(sku);
    if (b === null) { semSaldoBling++; continue; }
    if (s.invQty !== b) divergente.push({ sku, bling: b, shopify: s.invQty, status: s.status, ativoBW });
    else estoqueOk++;
  }

  _report.resumo = {
    faltandoNaShopify: faltando.length,
    estoqueDivergente: divergente.length,
    estoqueOk,
    semSaldoBling,
    semBlingMatch: semBlingMatch.length,
    foraDaBW
  };
  _report.amostras = {
    faltando: faltando.slice(0, 100),
    divergente: divergente.slice(0, 200),
    semBlingMatch: semBlingMatch.slice(0, 100)
  };
  _report.listas = { faltando, divergente, semBlingMatch }; // listas completas ficam no arquivo
  _report.status = 'completed';
  _report.finishedAt = new Date().toISOString();
  _running = false;
  saveReport();
  logger.success(`=== ESTOQUE AUDIT OK === faltando=${faltando.length} divergente=${divergente.length} ok=${estoqueOk} semSaldoBling=${semSaldoBling} semBlingMatch=${semBlingMatch.length} foraBW=${foraDaBW}`);
}

// Inicia em background (ack imediato); _run roda solto
function start() {
  if (_running) return { error: 'Auditoria de estoque ja em andamento' };
  _running = true;
  _report = freshReport();
  _report.status = 'running';
  _report.geradoEm = new Date().toISOString();
  saveReport();
  _run().catch(e => { logger.error(`Estoque-audit fatal: ${e.message}`); _report.status = 'error'; _running = false; saveReport(); });
  return { status: 'started' };
}

function stop() { _running = false; return { status: 'stopping' }; }
function status() { return { running: _running, report: _running ? _report : loadReport() }; }

module.exports = { start, stop, status };
