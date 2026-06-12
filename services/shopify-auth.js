const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Tokens por loja, salvos no volume (/app/data) e fora do Git (data/*.json)
const TOKENS_PATH = path.join(__dirname, '..', 'data', 'shopify-tokens.json');

function getConfig() {
  return {
    clientId: process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
    scopes: process.env.SHOPIFY_SCOPES || 'read_products,write_products,read_inventory,write_inventory,read_orders',
    appUrl: String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    defaultShop: process.env.SHOPIFY_SHOP || ''
  };
}

// Monta a URL de autorizacao (tela de permissoes do Shopify)
function getInstallUrl(shop) {
  const c = getConfig();
  const redirectUri = `${c.appUrl}/auth/shopify/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  const url = `https://${shop}/admin/oauth/authorize`
    + `?client_id=${encodeURIComponent(c.clientId)}`
    + `&scope=${encodeURIComponent(c.scopes)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${state}`;
  return { url, state, redirectUri };
}

// Valida o HMAC do callback (confirma que a requisicao veio mesmo do Shopify)
function validHmac(query) {
  const c = getConfig();
  if (!c.clientSecret) return false;
  const params = { ...query };
  const hmac = params.hmac;
  delete params.hmac;
  delete params.signature;
  const message = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const digest = crypto.createHmac('sha256', c.clientSecret).update(message).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(String(hmac || ''), 'utf8'));
  } catch (e) {
    return false;
  }
}

// Troca o code temporario pelo access_token permanente da loja
async function exchangeCodeForToken(shop, code) {
  const c = getConfig();
  const resp = await axios.post(`https://${shop}/admin/oauth/access_token`, {
    client_id: c.clientId,
    client_secret: c.clientSecret,
    code
  }, { headers: { 'Content-Type': 'application/json' } });

  const all = loadAll();
  all[shop] = {
    shop,
    access_token: resp.data.access_token,
    scope: resp.data.scope,
    obtained_at: Date.now()
  };
  saveAll(all);
  return all[shop];
}

function loadAll() {
  if (!fs.existsSync(TOKENS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')); } catch (e) { return {}; }
}

function saveAll(obj) {
  const dir = path.dirname(TOKENS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(obj, null, 2));
}

function loadTokens(shop) {
  const all = loadAll();
  if (shop) return all[shop] || null;
  const keys = Object.keys(all);
  return keys.length ? all[keys[0]] : null;
}

function isAuthenticated(shop) {
  const t = loadTokens(shop);
  return !!(t && t.access_token);
}

module.exports = { getConfig, getInstallUrl, validHmac, exchangeCodeForToken, loadTokens, isAuthenticated };
