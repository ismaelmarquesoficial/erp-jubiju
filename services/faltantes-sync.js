// services/faltantes-sync.js
// Cria na Shopify os produtos ATIVOS na BW que estao faltando (lista data/faltando-real.json -> ausenteDeVerdade).
// Por SKU: acha no Bling por codigo -> detalhes -> processProduct -> upsertProduct.
// dryRun=true apenas diagnostica (read-only, NAO escreve na Shopify). Roda em background com status.
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const blingProducts = require('./bling-products');
const shopifyProducts = require('./shopify-products');

const FALTANTES_PATH = path.join(__dirname, '..', 'data', 'faltando-real.json');
const REPORT_PATH = path.join(__dirname, '..', 'data', 'faltantes-sync.json');

let _running = false;
let _report = freshReport();

// Estrutura inicial do relatorio
function freshReport() {
  return {
    status: 'idle', geradoEm: null, finishedAt: null,
    dryRun: true, statusAlvo: null,
    total: 0, processados: 0,
    resumo: { criavel: 0, criados: 0, jaNaShopify: 0, naoNoBling: 0, kit: 0, erros: 0 },
    itens: [] // { sku, resultado, blingId, productId, titulo, msg }
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

// Le a lista de SKUs faltantes (gerada pela auditoria de cobertura)
function loadFaltantes() {
  try {
    const j = JSON.parse(fs.readFileSync(FALTANTES_PATH, 'utf8'));
    return Array.isArray(j.ausenteDeVerdade) ? j.ausenteDeVerdade : [];
  } catch (e) { return []; }
}

// Extrai o SKU base do produto processado (1a variacao ou simples) para checar duplicata na Shopify
function baseSkuOf(processed, fallback) {
  if (processed.variations && processed.variations[0]) return processed.variations[0].sku;
  if (processed.simple) return processed.simple.sku;
  return fallback;
}

async function _run(opts) {
  const skus = (opts.skus && opts.skus.length) ? opts.skus : loadFaltantes();
  _report.total = skus.length;
  _report.dryRun = opts.dryRun !== false; // default = dry-run (seguro)
  _report.statusAlvo = opts.status || null;
  saveReport();
  const sleepMs = opts.sleepMs || 350;

  for (const raw of skus) {
    if (!_running) { _report.status = 'stopped'; saveReport(); logger.warning('Faltantes-sync interrompido'); return; }
    const sku = String(raw || '').trim();
    const item = { sku, resultado: null, blingId: null, productId: null, titulo: '', msg: '' };
    try {
      const found = await blingProducts.fetchByCodigo(sku);
      await blingProducts.sleep(sleepMs);
      const match = found.find(p => String(p.codigo || '').trim().toLowerCase() === sku.toLowerCase()) || found[0];

      if (!match) {
        item.resultado = 'naoNoBling'; _report.resumo.naoNoBling++;
      } else {
        item.blingId = match.id;
        const details = await blingProducts.fetchProductDetails(match.id);
        await blingProducts.sleep(sleepMs);
        const processed = blingProducts.processProduct(details, details);
        item.titulo = (details.nome || '').trim();

        if (processed.kit) {
          item.resultado = 'kit'; _report.resumo.kit++; // kit nao suportado pelo sync de produto
        } else {
          const existing = await shopifyProducts.findProductBySku(baseSkuOf(processed, sku));
          if (existing) {
            item.resultado = 'jaNaShopify'; item.productId = existing.legacyResourceId; _report.resumo.jaNaShopify++;
          } else if (_report.dryRun) {
            item.resultado = 'criavel'; _report.resumo.criavel++; // existe no Bling, falta na Shopify
          } else {
            const descricao = details.descricaoComplementar || details.descricaoCurta || details.descricao || '';
            const r = await shopifyProducts.upsertProduct(processed, { descricao, status: opts.status || null });
            item.resultado = 'criado'; item.productId = r.productId; _report.resumo.criados++;
            await blingProducts.sleep(sleepMs);
          }
        }
      }
    } catch (e) {
      item.resultado = 'erro'; item.msg = e.message; _report.resumo.erros++;
      logger.error(`Faltantes-sync ${sku}: ${e.message}`);
    }
    _report.itens.push(item);
    _report.processados++;
    if (_report.processados % 10 === 0) saveReport();
  }

  _report.status = 'completed';
  _report.finishedAt = new Date().toISOString();
  _running = false;
  saveReport();
  logger.success(`=== FALTANTES-SYNC OK (dryRun=${_report.dryRun}) === ${JSON.stringify(_report.resumo)}`);
}

// Inicia em background (ack imediato). opts: { dryRun, status, sleepMs, skus[] }
function start(opts = {}) {
  if (_running) return { error: 'Faltantes-sync ja em andamento' };
  _running = true;
  _report = freshReport();
  _report.status = 'running';
  _report.geradoEm = new Date().toISOString();
  saveReport();
  _run(opts).catch(e => { logger.error(`Faltantes-sync fatal: ${e.message}`); _report.status = 'error'; _running = false; saveReport(); });
  return { status: 'started', dryRun: opts.dryRun !== false, statusAlvo: opts.status || null };
}

function stop() { _running = false; return { status: 'stopping' }; }
function status() { return { running: _running, report: _running ? _report : loadReport() }; }

module.exports = { start, stop, status };
