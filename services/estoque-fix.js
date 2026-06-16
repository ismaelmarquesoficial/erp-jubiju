// services/estoque-fix.js
// Corrige o estoque (available) na Shopify para uma lista de { sku, qty } (qty = saldo Bling alvo).
// Atualiza SOMENTE o nivel de inventario (nao reescreve o produto). dryRun=true so compara (read-only).
// Roda em background com status. Nao depende do Bling (so Shopify).
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const shopifyProducts = require('./shopify-products');

const REPORT_PATH = path.join(__dirname, '..', 'data', 'estoque-fix.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let _running = false;
let _report = freshReport();

function freshReport() {
  return {
    status: 'idle', geradoEm: null, finishedAt: null, dryRun: true,
    total: 0, processados: 0,
    resumo: { mudaria: 0, atualizados: 0, jaOk: 0, naoEncontrado: 0, erros: 0 },
    itens: [] // { sku, alvo, antes, resultado, msg }
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

async function _run(opts) {
  const itens = Array.isArray(opts.itens) ? opts.itens : [];
  _report.total = itens.length;
  _report.dryRun = opts.dryRun !== false; // default = dry-run (seguro)
  saveReport();
  const sleepMs = opts.sleepMs || 250;

  for (const it of itens) {
    if (!_running) { _report.status = 'stopped'; saveReport(); logger.warning('Estoque-fix interrompido'); return; }
    const sku = String(it.sku || '').trim();
    const alvo = Math.max(0, parseInt(it.qty) || 0);
    const r = { sku, alvo, antes: null, resultado: null, msg: '' };
    try {
      const cur = await shopifyProducts.getInventoryBySku(sku);
      if (!cur) {
        r.resultado = 'naoEncontrado'; _report.resumo.naoEncontrado++;
      } else {
        r.antes = cur.available;
        if (cur.available === alvo) {
          r.resultado = 'jaOk'; _report.resumo.jaOk++;
        } else if (_report.dryRun) {
          r.resultado = 'mudaria'; _report.resumo.mudaria++;
        } else {
          await shopifyProducts.setInventoryAvailableBySku(sku, alvo);
          r.resultado = 'atualizado'; _report.resumo.atualizados++;
        }
      }
    } catch (e) {
      r.resultado = 'erro'; r.msg = e.message; _report.resumo.erros++;
      logger.error(`Estoque-fix ${sku}: ${e.message}`);
    }
    _report.itens.push(r);
    _report.processados++;
    if (_report.processados % 10 === 0) saveReport();
    await sleep(sleepMs);
  }

  _report.status = 'completed';
  _report.finishedAt = new Date().toISOString();
  _running = false;
  saveReport();
  logger.success(`=== ESTOQUE-FIX OK (dryRun=${_report.dryRun}) === ${JSON.stringify(_report.resumo)}`);
}

// Inicia em background. opts: { dryRun, sleepMs, itens:[{sku,qty}] }
function start(opts = {}) {
  if (_running) return { error: 'Estoque-fix ja em andamento' };
  if (!Array.isArray(opts.itens) || !opts.itens.length) return { error: 'Informe itens:[{sku,qty}]' };
  _running = true;
  _report = freshReport();
  _report.status = 'running';
  _report.geradoEm = new Date().toISOString();
  saveReport();
  _run(opts).catch(e => { logger.error(`Estoque-fix fatal: ${e.message}`); _report.status = 'error'; _running = false; saveReport(); });
  return { status: 'started', dryRun: opts.dryRun !== false, total: opts.itens.length };
}

function stop() { _running = false; return { status: 'stopping' }; }
function status() { return { running: _running, report: _running ? _report : loadReport() }; }

module.exports = { start, stop, status };
