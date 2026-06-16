// services/shopify-products.js
// Cria/atualiza produtos na Shopify a partir do produto processado do Bling,
// validando a CATEGORIA na BW (SKU Bling -> referencia BW -> hierarquia -> colecao Shopify).
const axios = require('axios');
const logger = require('../utils/logger');
const imageHandler = require('./image-handler');

const SHOP = process.env.SHOPIFY_SHOP;
const API_VER = '2026-04';
const BW_BASE = (process.env.BW_API_BASE || '').replace(/\/+$/, '');
const BW_TOKEN = process.env.BW_TOKEN;

// ===================== TOKEN SHOPIFY (client_credentials) =====================
let _token = null, _tokenAt = 0;
async function getToken() {
  if (_token && (Date.now() - _tokenAt) < 50 * 60 * 1000) return _token;
  const resp = await axios.post(`https://${SHOP}/admin/oauth/access_token`, {
    client_id: process.env.SHOPIFY_CLIENT_ID,
    client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    grant_type: 'client_credentials'
  }, { headers: { 'Content-Type': 'application/json' } });
  _token = resp.data.access_token; _tokenAt = Date.now();
  return _token;
}

async function rest(method, path, data) {
  const token = await getToken();
  return axios({
    method, url: `https://${SHOP}/admin/api/${API_VER}${path}`,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    data, timeout: 40000
  });
}

async function gql(query, variables) {
  const token = await getToken();
  const resp = await axios.post(`https://${SHOP}/admin/api/${API_VER}/graphql.json`,
    { query, variables }, { headers: { 'X-Shopify-Access-Token': token }, timeout: 40000 });
  if (resp.data.errors) throw new Error('GraphQL: ' + JSON.stringify(resp.data.errors));
  return resp.data.data;
}

// ===================== BW: categoria por referencia =====================
async function bwGet(classe, params) {
  const resp = await axios.get(`${BW_BASE}/${classe}`, {
    headers: { token: BW_TOKEN }, params, timeout: 30000
  });
  return resp.data;
}

// O filtro ?referencia= da BW e ignorado, entao indexamos TODOS os produtos uma vez
// (referencia -> categoria). A categoria ja vem embutida em id_hierarquia_produto.nome.
let _bwIndex = null;
async function loadBwIndex() {
  if (_bwIndex) return _bwIndex;
  _bwIndex = {};
  let page = 1, totalPag = 1;
  do {
    const j = await bwGet('produtos', { limitePagina: 100, pagina: page });
    for (const p of (j.registros || [])) {
      const ref = String(p.referencia || '').trim();
      if (!ref) continue;
      const cat = (p.id_hierarquia_produto && p.id_hierarquia_produto.nome) ? p.id_hierarquia_produto.nome : null;
      const ativo = (p.ativo === true || p.ativo === 'true' || p.ativo === 1 || p.ativo === '1');
      _bwIndex[ref] = { categoria: cat, descricao: p.descricao, bwId: p.id, ativo };
    }
    totalPag = j.totalPaginas || 1;
    page++;
  } while (page <= totalPag);
  logger.info(`BW index: ${Object.keys(_bwIndex).length} produtos indexados por referencia`);
  return _bwIndex;
}

let _cols = null; // handle -> { id (gid), title }
async function loadCollections() {
  if (_cols) return _cols;
  const data = await gql('{ collections(first:100){ nodes{ id handle title } } }');
  _cols = {};
  for (const c of data.collections.nodes) _cols[c.handle] = { id: c.id, title: c.title };
  return _cols;
}

function slug(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Resolve categoria: SKU -> produto BW (por referencia) -> hierarquia -> colecao Shopify
async function resolveCategoryBySku(sku) {
  if (!sku) return { nome: null, handle: null, collectionId: null, matched: false };
  const idx = await loadBwIndex();
  const rec = idx[String(sku).trim()];
  if (!rec) return { nome: null, handle: null, collectionId: null, matched: false, ativo: null };
  const nome = (rec.categoria || '').trim() || null;
  if (!nome) return { nome: null, handle: null, collectionId: null, matched: true, bwId: rec.bwId, ativo: rec.ativo };
  const handle = slug(nome);
  const cols = await loadCollections();
  return {
    nome, handle, collectionId: cols[handle] ? cols[handle].id : null,
    matched: true, bwId: rec.bwId, descricaoBw: rec.descricao, ativo: rec.ativo
  };
}

// ===================== Shopify: achar produto existente por SKU =====================
async function findProductBySku(sku) {
  if (!sku) return null;
  const data = await gql(
    `query($q:String!){ productVariants(first:1, query:$q){ nodes{ id sku product{ id legacyResourceId } } } }`,
    { q: `sku:${JSON.stringify(sku)}` }
  );
  const node = data.productVariants.nodes[0];
  return node ? node.product : null;
}

// ===================== Criar produto na Shopify =====================
// processed = saida de blingProducts.processProduct() (somente .simple ou .variations)
async function upsertProduct(processed, opts = {}) {
  const isVar = processed.variations && processed.variations.length > 0;
  const base = isVar ? processed.variations[0] : processed.simple;
  if (!base) throw new Error('Produto sem dados (nem simple nem variations)');

  const sku = base.spu || base.sku;
  const titulo = base.titulo || base.sku;

  // 1) categoria via BW
  const categoria = await resolveCategoryBySku(sku);

  // 2) ja existe?
  const existing = await findProductBySku(base.sku);
  if (existing && !opts.update) {
    logger.info(`Produto ${sku} ja existe na Shopify (id ${existing.legacyResourceId}) - pulando`);
    return { skipped: true, productId: existing.id, categoria };
  }

  // 3) montar payload
  let optionNames = [];
  let variants = [];
  let images = [];

  if (isVar) {
    // nomes de opcao = uniao dos atributos (Cor, Tamanho...)
    const namesSet = [];
    for (const v of processed.variations) {
      for (const a of (v.variantes || [])) if (!namesSet.includes(a.name)) namesSet.push(a.name);
    }
    optionNames = namesSet.length ? namesSet.slice(0, 3) : ['Variação'];

    for (const v of processed.variations) {
      const opt = {};
      (v.variantes || []).forEach(a => { opt[a.name] = a.value; });
      const variant = {
        price: String(v.precoVarejo),
        sku: v.sku,
        barcode: v.codigoBarras || '',
        inventory_management: 'shopify',
        inventory_quantity: toInt(v.quantidade),
        weight: toNum(v.peso), weight_unit: 'g'
      };
      optionNames.forEach((n, i) => { variant['option' + (i + 1)] = opt[n] || 'Único'; });
      variants.push(variant);
      const vImgs = await rehostImages(v.imagens, v.sku, v.titulo, opts.rehostImages);
      for (const u of vImgs) if (!images.find(im => im.src === u)) images.push({ src: u });
    }
  } else {
    const s = processed.simple;
    optionNames = ['Title'];
    variants = [{
      price: String(s.precoVarejo),
      sku: s.sku,
      barcode: s.codigoBarras || '',
      inventory_management: 'shopify',
      inventory_quantity: toInt(s.quantidade),
      weight: toNum(s.peso), weight_unit: 'g'
    }];
    images = (await rehostImages(s.imagens, s.sku, s.titulo, opts.rehostImages)).map(u => ({ src: u }));
  }

  const productBody = {
    product: {
      title: titulo,
      body_html: opts.descricao || '',
      vendor: opts.vendor || 'Jubijufinas',
      product_type: categoria.nome || '',
      tags: categoria.nome ? [categoria.nome] : [],
      status: opts.status || (categoria.matched && categoria.ativo === false ? 'draft' : 'active'),
      options: optionNames.map(name => ({ name })),
      variants,
      images,
      metafields: buildMetafields(base, sku)
    }
  };

  let product;
  if (existing && opts.update) {
    const resp = await rest('put', `/products/${existing.legacyResourceId}.json`, productBody);
    product = resp.data.product;
    logger.success(`Produto atualizado na Shopify: ${titulo} (${sku})`);
  } else {
    const resp = await rest('post', `/products.json`, productBody);
    product = resp.data.product;
    logger.success(`Produto criado na Shopify: ${titulo} (${sku}) | categoria: ${categoria.nome || 'N/D'}`);
  }

  // 4) adicionar a colecao da categoria
  if (categoria.collectionId) {
    try {
      await gql(
        `mutation($id:ID!,$pids:[ID!]!){ collectionAddProducts(id:$id, productIds:$pids){ userErrors{ message } } }`,
        { id: categoria.collectionId, pids: [`gid://shopify/Product/${product.id}`] }
      );
    } catch (e) { logger.warning(`Falha ao adicionar ${sku} na colecao ${categoria.handle}: ${e.message}`); }
  } else if (categoria.nome) {
    logger.warning(`Categoria "${categoria.nome}" (SKU ${sku}) sem colecao Shopify equivalente.`);
  }

  return { productId: product.id, handle: product.handle, categoria, variants: variants.length };
}

function toInt(v) { const n = parseInt(v); return isNaN(n) ? 0 : Math.max(0, n); }
function toNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

// Gera os metafields com as caracteristicas BR que a Shopify nao tem nativas:
// fiscal (NCM/CEST/origem/unidade) e dimensoes (comprimento/largura/altura/peso).
function buildMetafields(base, blingSku) {
  const mf = [];
  if (blingSku) mf.push({ namespace: 'bling', key: 'sku', type: 'single_line_text_field', value: String(blingSku) });
  const txt = (ns, key, val) => { const s = (val == null ? '' : String(val)).trim(); if (s) mf.push({ namespace: ns, key, type: 'single_line_text_field', value: s }); };
  const dec = (ns, key, val) => { const n = toNum(val); if (n > 0) mf.push({ namespace: ns, key, type: 'number_decimal', value: String(n) }); };
  const int = (ns, key, val) => { const n = toInt(val); if (n > 0) mf.push({ namespace: ns, key, type: 'number_integer', value: String(n) }); };
  txt('fiscal', 'ncm', base.ncm);
  txt('fiscal', 'cest', base.cest);
  txt('fiscal', 'origem', base.origem);
  txt('fiscal', 'unidade', base.unidade);
  dec('dimensoes', 'comprimento_cm', base.comprimento);
  dec('dimensoes', 'largura_cm', base.largura);
  dec('dimensoes', 'altura_cm', base.altura);
  int('dimensoes', 'peso_g', base.peso);
  return mf;
}

// Re-hospeda as imagens no volume do servidor (URLs publicas permanentes).
// rehost===false usa as URLs originais do Bling (links S3 temporarios).
async function rehostImages(urls, sku, titulo, rehost) {
  if (!urls || urls.length === 0) return [];
  if (rehost === false) return urls;
  try {
    const joined = await imageHandler.processMultipleImages(urls, sku, titulo);
    return joined ? joined.split(',').map(s => s.trim()).filter(Boolean) : urls;
  } catch (e) { logger.warning(`Re-host de imagem falhou (${sku}): ${e.message}`); return urls; }
}

// Busca o produto na Shopify (por SKU de variante) com os campos da auditoria
async function findProductFull(sku) {
  if (!sku) return null;
  const data = await gql(
    `query($q:String!){ productVariants(first:1, query:$q){ nodes{ product{ id legacyResourceId title productType status featuredImage{id} variantsCount{count} blingsku:metafield(namespace:"bling",key:"sku"){value} ncm:metafield(namespace:"fiscal",key:"ncm"){value} } } } }`,
    { q: `sku:${JSON.stringify(sku)}` }
  );
  const n = data.productVariants.nodes[0];
  return n ? n.product : null;
}

// Backfill do metafield bling.sku + correcao do product_type (trim) + auditoria do produto
async function tagAndAudit(processed) {
  const isVar = processed.variations && processed.variations.length > 0;
  const base = isVar ? processed.variations[0] : processed.simple;
  if (!base) return null;
  const sku = base.spu || base.sku;
  const categoria = await resolveCategoryBySku(sku);
  const prod = await findProductFull(base.sku);
  if (!prod) return { sku, found: false };
  if (!prod.blingsku || prod.blingsku.value !== String(sku)) {
    await gql(`mutation($mfs:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$mfs){ userErrors{message} } }`,
      { mfs: [{ ownerId: prod.id, namespace: 'bling', key: 'sku', type: 'single_line_text_field', value: String(sku) }] });
  }
  if (categoria.nome && prod.productType !== categoria.nome) {
    await gql(`mutation($id:ID!,$t:String!){ productUpdate(input:{id:$id, productType:$t}){ userErrors{ message } } }`,
      { id: prod.id, t: categoria.nome });
  }
  const expVar = isVar ? processed.variations.length : 1;
  return {
    sku, found: true,
    catOk: !categoria.nome || prod.productType === categoria.nome,
    cat: categoria.nome, catBefore: prod.productType,
    varOk: prod.variantsCount.count === expVar, expVar, gotVar: prod.variantsCount.count,
    imgOk: !!prod.featuredImage,
    fiscalOk: !!(prod.ncm && prod.ncm.value)
  };
}

// ===================== Inventario: setar quantidade disponivel (available) por SKU =====================
let _locId = null;
// Location principal (a que envia estoque). Cacheada.
async function getPrimaryLocationId() {
  if (_locId) return _locId;
  const d = await gql(`{ locations(first:10){ nodes{ id isActive shipsInventory } } }`);
  const n = d.locations.nodes || [];
  const pick = n.find(l => l.isActive && l.shipsInventory) || n.find(l => l.isActive) || n[0];
  _locId = pick ? pick.id : null;
  return _locId;
}

// Le o estoque atual (available) de uma variante por SKU. null = SKU nao achado na Shopify.
async function getInventoryBySku(sku) {
  if (!sku) return null;
  const d = await gql(
    `query($q:String!){ productVariants(first:1, query:$q){ nodes{ id inventoryItem{ id inventoryLevels(first:10){ nodes{ location{ id } quantities(names:["available"]){ quantity } } } } } } }`,
    { q: `sku:${JSON.stringify(sku)}` }
  );
  const v = d.productVariants.nodes[0];
  if (!v) return null;
  const lvls = (v.inventoryItem.inventoryLevels.nodes) || [];
  const loc = await getPrimaryLocationId();
  const lvl = lvls.find(l => l.location.id === loc) || lvls[0];
  const available = (lvl && lvl.quantities[0]) ? lvl.quantities[0].quantity : null;
  return { variantId: v.id, inventoryItemId: v.inventoryItem.id, locationId: lvl ? lvl.location.id : loc, available };
}

// Seta a quantidade 'available' de uma variante por SKU na location dela. Retorna { found, antes, depois }.
async function setInventoryAvailableBySku(sku, qty) {
  const cur = await getInventoryBySku(sku);
  if (!cur || !cur.locationId) return { sku, found: false };
  const q = Math.max(0, parseInt(qty) || 0);
  // compareQuantity = valor atual lido (compare-and-swap: aborta se o estoque mudou no meio-tempo).
  const d = await gql(
    `mutation($input:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$input){ userErrors{ field message } } }`,
    { input: { name: 'available', reason: 'correction',
      quantities: [{ inventoryItemId: cur.inventoryItemId, locationId: cur.locationId, quantity: q, compareQuantity: (cur.available == null ? 0 : cur.available) }] } }
  );
  const errs = d.inventorySetQuantities.userErrors;
  if (errs && errs.length) throw new Error(errs.map(e => e.message).join('; '));
  return { sku, found: true, antes: cur.available, depois: q };
}

module.exports = { getToken, resolveCategoryBySku, findProductBySku, findProductFull, tagAndAudit, upsertProduct, loadCollections, loadBwIndex, getPrimaryLocationId, getInventoryBySku, setInventoryAvailableBySku };
