require('dotenv').config();
const express = require('express');
const path = require('path');
const blingAuth = require('./services/bling-auth');
const shopifyAuth = require('./services/shopify-auth');
const shopifyProducts = require('./services/shopify-products');
const blingProducts = require('./services/bling-products');
const googleWebhook = require('./services/google-webhook');
const imageHandler = require('./services/image-handler');
const upsellerXlsx = require('./services/upseller-xlsx');
const estoqueAudit = require('./services/estoque-audit');
const faltantesSync = require('./services/faltantes-sync');
const estoqueFix = require('./services/estoque-fix');
const logger = require('./utils/logger');
const progress = require('./utils/progress');
const rowstore = require('./utils/rowstore');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve as imagens salvas localmente em <PUBLIC_BASE_URL>/imagens/...
// (rota explicita para funcionar mesmo quando IMAGES_DIR aponta para um volume fora de public/)
app.use('/imagens', express.static(imageHandler.IMAGES_DIR));

// Estado da importacao
let importRunning = false;
let importPaused = false;

// ===================== ROTAS AUTH BLING =====================

app.get('/auth/bling', (req, res) => {
  const { url, state } = blingAuth.getAuthorizeUrl();
  logger.info(`Redirecionando para autorizacao Bling (state: ${state})`);
  res.redirect(url);
});

app.get('/auth/bling/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    logger.error('Callback sem authorization code');
    return res.status(400).send('Erro: authorization code nao recebido');
  }

  try {
    logger.info('Trocando authorization code por tokens...');
    const tokens = await blingAuth.exchangeCodeForTokens(code);
    logger.success('Tokens do Bling obtidos com sucesso!');
    res.redirect('/?auth=success');
  } catch (err) {
    logger.error(`Erro ao obter tokens: ${err.message}`);
    res.status(500).send(`Erro ao obter tokens: ${err.message}`);
  }
});

// ===================== ROTAS AUTH SHOPIFY =====================

app.get('/auth/shopify', (req, res) => {
  const cfg = shopifyAuth.getConfig();
  const shop = String(req.query.shop || cfg.defaultShop || '').trim();
  if (!shop) return res.status(400).send('Informe a loja: /auth/shopify?shop=suaLoja.myshopify.com');
  if (!cfg.clientId || !cfg.appUrl) return res.status(500).send('Shopify nao configurado (SHOPIFY_CLIENT_ID / PUBLIC_BASE_URL).');
  const { url, redirectUri } = shopifyAuth.getInstallUrl(shop);
  logger.info(`Shopify: iniciando instalacao para ${shop} (callback ${redirectUri})`);
  res.redirect(url);
});

app.get('/auth/shopify/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).send('Callback Shopify sem shop/code');
  if (!shopifyAuth.validHmac(req.query)) {
    logger.error('Shopify callback: HMAC invalido');
    return res.status(400).send('HMAC invalido');
  }
  try {
    await shopifyAuth.exchangeCodeForToken(shop, code);
    logger.success(`Shopify: app instalado em ${shop}, access_token salvo.`);
    res.send('App Shopify instalado com sucesso! Pode fechar esta aba.');
  } catch (err) {
    logger.error(`Shopify: erro ao trocar code por token: ${err.message}`);
    res.status(500).send('Erro ao obter token Shopify: ' + err.message);
  }
});

// ===================== ROTAS API =====================

app.get('/api/status', async (req, res) => {
  const blingOk = blingAuth.isAuthenticated();
  const tokens = blingAuth.loadTokens();
  let sheetsOk = false;
  let sheetsError = '';

  if (process.env.GOOGLE_WEBHOOK_URL) {
    const test = await googleWebhook.testConnection();
    sheetsOk = test.connected;
    sheetsError = test.error || '';
  }

  res.json({
    bling: {
      authenticated: blingOk,
      tokenExpires: tokens ? new Date(tokens.obtained_at + tokens.expires_in * 1000).toISOString() : null
    },
    sheets: {
      connected: sheetsOk,
      webhookConfigured: !!process.env.GOOGLE_WEBHOOK_URL,
      error: sheetsError
    },
    import: {
      running: importRunning,
      paused: importPaused,
      progress: progress.load()
    }
  });
});

app.get('/api/import/progress', (req, res) => {
  res.json(progress.load());
});

// Debug: ver produto por ID
app.get('/api/debug/product/:id', async (req, res) => {
  try {
    const details = await blingProducts.fetchProductDetails(req.params.id);
    return res.json({ product: details });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Debug: ver estrutura real de um produto do Bling
app.get('/api/debug/product', async (req, res) => {
  try {
    // Busca a primeira pagina e retorna o primeiro com detalhes
    const page = await blingProducts.fetchProductsPage(1, 5);
    const products = page.data || [];
    if (products.length === 0) return res.json({ error: 'Nenhum produto encontrado' });

    const details = await blingProducts.fetchProductDetails(products[0].id);
    // Se tem variacoes, pega um com variacao tambem
    let withVariation = null;
    for (const p of products) {
      const d = await blingProducts.fetchProductDetails(p.id);
      if (d.variacoes && d.variacoes.length > 0) {
        withVariation = d;
        break;
      }
    }

    res.json({
      listItem: products[0],
      details: details,
      withVariation: withVariation,
      keys: {
        listKeys: Object.keys(products[0]),
        detailKeys: Object.keys(details),
        variationKeys: withVariation?.variacoes?.[0] ? Object.keys(withVariation.variacoes[0]) : []
      }
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ===================== SHOPIFY: SYNC DE PRODUTOS =====================

// Valida a categoria de um SKU consultando a BW (SKU -> referencia -> hierarquia -> colecao)
app.get('/api/shopify/category/:sku', async (req, res) => {
  try {
    const cat = await shopifyProducts.resolveCategoryBySku(req.params.sku);
    res.json(cat);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sincroniza UM produto do Bling para a Shopify (por id do Bling).
// Body opcional: { update: true } para atualizar se ja existir; { status: 'draft' } para rascunho.
app.post('/api/shopify/sync/:blingId', async (req, res) => {
  try {
    if (!blingAuth.isAuthenticated()) return res.json({ error: 'Bling nao autenticado. Acesse /auth/bling primeiro.' });
    const details = await blingProducts.fetchProductDetails(req.params.blingId);
    const processed = blingProducts.processProduct(details, details);
    if (processed.kit) return res.json({ error: 'Produto e KIT - sync de kit ainda nao implementado', kit: processed.kit });
    const descricao = details.descricaoComplementar || details.descricaoCurta || details.descricao || '';
    const result = await shopifyProducts.upsertProduct(processed, Object.assign({ descricao }, req.body || {}));
    res.json({ status: 'ok', result });
  } catch (err) {
    logger.error(`Sync Shopify falhou: ${err.message}`);
    res.status(500).json({ error: err.message, detail: err.response && err.response.data });
  }
});

// ===== SYNC EM LOTE (Bling -> Shopify) — lotes de 100, throttle + pausa entre lotes =====
let shopifySyncRunning = false;
let shopifySyncPaused = false;

app.post('/api/shopify/sync-batch', (req, res) => {
  if (shopifySyncRunning) return res.json({ error: 'Sync em lote ja em andamento' });
  if (!blingAuth.isAuthenticated()) return res.json({ error: 'Bling nao autenticado. Acesse /auth/bling.' });
  const b = req.body || {};
  const opts = {
    status: b.status || null,                       // null = segue o ativo da BW
    update: !!b.update,                             // true = atualiza se ja existir
    sleepMs: b.sleepMs || 600,                      // throttle entre produtos
    pausaEntreLotesMs: b.pausaEntreLotesMs || 5000, // pausa entre paginas/lotes
    reset: !!b.reset,
    rescan: !!b.rescan                              // re-varre todas as paginas (mantem syncedIds) p/ recuperar erros
  };
  shopifySyncRunning = true; shopifySyncPaused = false;
  res.json({ status: 'started', opts });
  runShopifySync(opts).catch(err => { logger.error(`Sync lote fatal: ${err.message}`); shopifySyncRunning = false; });
});

app.get('/api/shopify/sync-batch/status', (req, res) => {
  res.json({ running: shopifySyncRunning, paused: shopifySyncPaused, progress: loadSyncProg() });
});
app.post('/api/shopify/sync-batch/pause', (req, res) => { shopifySyncPaused = true; res.json({ status: 'paused' }); });
app.post('/api/shopify/sync-batch/resume', (req, res) => { shopifySyncPaused = false; res.json({ status: 'resumed' }); });
app.post('/api/shopify/sync-batch/stop', (req, res) => { shopifySyncRunning = false; res.json({ status: 'stopping' }); });

// ===== BACKFILL bling_sku + AUDITORIA (Bling x Shopify), produto a produto =====
let auditRunning = false;
app.post('/api/shopify/backfill-audit', (req, res) => {
  if (auditRunning) return res.json({ error: 'Auditoria ja em andamento' });
  if (!blingAuth.isAuthenticated()) return res.json({ error: 'Bling nao autenticado.' });
  auditRunning = true;
  res.json({ status: 'started', opts: req.body || {} });
  runBackfillAudit(req.body || {}).catch(err => { logger.error(`Auditoria fatal: ${err.message}`); auditRunning = false; });
});
app.get('/api/shopify/backfill-audit/status', (req, res) => { res.json({ running: auditRunning, report: loadAuditRep() }); });
app.post('/api/shopify/backfill-audit/stop', (req, res) => { auditRunning = false; res.json({ status: 'stopping' }); });

// ===== AUDITORIA DE ESTOQUE: BW(ativo) x Shopify x Bling(saldo real) =====
app.post('/api/audit/estoque', (req, res) => {
  if (!blingAuth.isAuthenticated()) return res.json({ error: 'Bling nao autenticado. Acesse /auth/bling.' });
  res.json(estoqueAudit.start());
});
app.get('/api/audit/estoque/status', (req, res) => res.json(estoqueAudit.status()));
app.post('/api/audit/estoque/stop', (req, res) => res.json(estoqueAudit.stop()));

// ===== CORRIGIR FALTANTES: cria na Shopify os ativos-BW ausentes (data/faltando-real.json) =====
// Body: { dryRun (default true), status ('draft'|'active'|null=segue BW), sleepMs, skus[] }
app.post('/api/shopify/sync-faltantes', (req, res) => {
  if (!blingAuth.isAuthenticated()) return res.json({ error: 'Bling nao autenticado. Acesse /auth/bling.' });
  res.json(faltantesSync.start(req.body || {}));
});
app.get('/api/shopify/sync-faltantes/status', (req, res) => res.json(faltantesSync.status()));
app.post('/api/shopify/sync-faltantes/stop', (req, res) => res.json(faltantesSync.stop()));

// ===== CORRIGIR ESTOQUE: ajusta o 'available' na Shopify para itens [{sku,qty}] (qty = saldo Bling) =====
// Body: { dryRun (default true), sleepMs, itens:[{sku,qty}] }. Atualiza so o inventario, nao o produto.
app.post('/api/shopify/fix-estoque', (req, res) => res.json(estoqueFix.start(req.body || {})));
app.get('/api/shopify/fix-estoque/status', (req, res) => res.json(estoqueFix.status()));
app.post('/api/shopify/fix-estoque/stop', (req, res) => res.json(estoqueFix.stop()));

app.post('/api/import/start', async (req, res) => {
  if (importRunning) {
    return res.json({ error: 'Importacao ja em andamento' });
  }

  if (!blingAuth.isAuthenticated()) {
    return res.json({ error: 'Bling nao autenticado. Acesse /auth/bling primeiro.' });
  }

  const { reset: shouldReset } = req.body || {};

  if (shouldReset) {
    progress.reset();
    rowstore.clear();
    logger.info('Progresso resetado. Iniciando do zero.');
  }

  importRunning = true;
  importPaused = false;
  res.json({ status: 'started' });

  // Rodar importacao em background
  runImport().catch(err => {
    logger.error(`Erro fatal na importacao: ${err.message}`);
    importRunning = false;
    progress.update({ status: 'error' });
  });
});

app.post('/api/import/pause', (req, res) => {
  if (!importRunning) {
    return res.json({ error: 'Nenhuma importacao em andamento' });
  }
  importPaused = true;
  logger.warning('Importacao pausada pelo usuario');
  progress.update({ status: 'paused' });
  res.json({ status: 'paused' });
});

app.post('/api/import/resume', (req, res) => {
  if (!importRunning) {
    // Se nao esta rodando, reiniciar de onde parou
    importRunning = true;
    importPaused = false;
    res.json({ status: 'resumed' });

    runImport().catch(err => {
      logger.error(`Erro fatal na importacao: ${err.message}`);
      importRunning = false;
      progress.update({ status: 'error' });
    });
    return;
  }

  importPaused = false;
  logger.info('Importacao retomada');
  progress.update({ status: 'running' });
  res.json({ status: 'resumed' });
});

app.post('/api/import/reset', (req, res) => {
  if (importRunning) {
    return res.json({ error: 'Para a importacao antes de resetar' });
  }
  progress.reset();
  rowstore.clear();
  logger.info('Progresso resetado');
  res.json({ status: 'reset' });
});

// ===================== EXPORTACAO XLSX UPSELLER =====================

app.post('/api/export/xlsx', async (req, res) => {
  try {
    const outDir = path.join(__dirname, 'public', 'exports');
    const jobs = [
      { type: 'simple', base: 'UpSeller_Unico' },
      { type: 'variation', base: 'UpSeller_Variante' }
    ];

    const files = [];
    for (const job of jobs) {
      const rows = rowstore.read(job.type);
      if (rows.length === 0) continue;
      logger.info(`Gerando ${job.base} (${rows.length} linhas)...`);
      const gen = await upsellerXlsx.generate(job.type, rows, outDir, job.base);
      for (const g of gen) files.push({ ...g, type: job.type, url: `/exports/${encodeURIComponent(g.file)}` });
    }

    const kitCount = rowstore.count('kit');
    if (kitCount > 0) {
      logger.warning(`${kitCount} linha(s) de KIT nao exportadas: falta o template "Produtos KIT" da UpSeller.`);
    }

    if (files.length === 0) {
      return res.json({ status: 'empty', message: 'Nenhuma linha para exportar. Rode a importacao primeiro.' });
    }

    logger.success(`Planilhas UpSeller geradas: ${files.map(f => f.file).join(', ')}`);
    res.json({ status: 'ok', files, kitPendente: kitCount });
  } catch (err) {
    logger.error(`Erro ao gerar xlsx: ${err.message}`);
    res.json({ status: 'error', error: err.message });
  }
});

// ===================== SSE LOGS =====================

app.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('data: {"type":"info","message":"Conectado ao stream de logs"}\n\n');
  logger.addClient(res);
});

// ===================== IMPORTACAO =====================

async function runImport() {
  const prog = progress.load();
  const startPage = prog.lastPage > 0 ? prog.lastPage : 1;

  progress.update({
    status: 'running',
    startedAt: prog.startedAt || new Date().toISOString()
  });

  logger.info('=== INICIANDO IMPORTACAO DE PRODUTOS DO BLING ===');

  let page = startPage;
  let hasMore = true;
  let simpleBatch = [];
  let variationBatch = [];
  let kitBatch = [];
  // 1 = grava cada produto no .jsonl imediatamente (flush por produto).
  // Assim o export fica sempre completo e nada se perde se o container reiniciar.
  const BATCH_SIZE = 1;

  try {
    while (hasMore && importRunning) {
      // Verificar pausa
      while (importPaused && importRunning) {
        await blingProducts.sleep(1000);
      }

      if (!importRunning) break;

      logger.progress(`Buscando pagina ${page}...`);

      let products;
      try {
        const response = await blingProducts.fetchProductsPage(page, 100);
        products = response.data || [];
      } catch (err) {
        if (err.response && err.response.status === 429) {
          logger.warning('Rate limit! Aguardando 60s...');
          await blingProducts.sleep(60000);
          continue;
        }
        throw err;
      }

      if (products.length === 0) {
        hasMore = false;
        logger.info('Nenhum produto na pagina. Fim da listagem.');
        break;
      }

      logger.info(`Pagina ${page}: ${products.length} produtos`);

      for (const product of products) {
        if (!importRunning) break;
        while (importPaused && importRunning) {
          await blingProducts.sleep(1000);
        }

        // Pular se ja processado
        if (progress.isProcessed(product.id)) {
          continue;
        }

        try {
          // Buscar detalhes completos
          logger.info(`Buscando detalhes: ${product.nome || product.id}`);
          const details = await blingProducts.fetchProductDetails(product.id);

          await blingProducts.sleep(350); // Rate limit

          // Pular produtos que sao variacoes filhas (tem codigoPai/estrutura.pai)
          // Eles ja serao processados quando buscarmos o produto pai
          const codigoPai = details.codigoPai
            || details.estrutura?.pai?.id
            || details.variacao?.produtoPai?.id
            || product.idProdutoPai
            || null;
          if (codigoPai) {
            logger.info(`Produto ${details.codigo} e variacao de ${codigoPai}, pulando (sera processado pelo pai)`);
            progress.markProcessed(product.id);
            continue;
          }

          // Processar
          const processed = blingProducts.processProduct(product, details);

          // Logar alertas
          for (const alert of processed.alerts) {
            if (alert.type === 'noPrice') {
              logger.warning(alert.message);
              progress.update({ stats: { noPrice: progress.load().stats.noPrice + 1 } });
            } else if (alert.type === 'noParentSku') {
              logger.warning(alert.message);
              progress.update({ stats: { noParentSku: progress.load().stats.noParentSku + 1 } });
            }
          }

          // Processar imagens (multiplas)
          if (processed.simple) {
            if (processed.simple.imagens && processed.simple.imagens.length > 0) {
              processed.simple.imagem = await imageHandler.processMultipleImages(
                processed.simple.imagens,
                processed.simple.sku,
                processed.simple.titulo
              );
            } else {
              processed.simple.imagem = '';
            }
            simpleBatch.push(googleWebhook.formatSimpleRow(processed.simple));
            progress.update({ stats: { simple: progress.load().stats.simple + 1 } });
          }

          if (processed.variations.length > 0) {
            for (const v of processed.variations) {
              if (v.imagens && v.imagens.length > 0) {
                v.imagem = await imageHandler.processMultipleImages(
                  v.imagens, v.sku, v.titulo
                );
              } else {
                v.imagem = '';
              }
              variationBatch.push(googleWebhook.formatVariationRow(v));
            }
            progress.update({ stats: { variation: progress.load().stats.variation + processed.variations.length } });
          }

          if (processed.kit) {
            if (processed.kit.imagens && processed.kit.imagens.length > 0) {
              processed.kit.imagem = await imageHandler.processMultipleImages(
                processed.kit.imagens, processed.kit.kitSku, processed.kit.titulo
              );
            } else {
              processed.kit.imagem = '';
            }
            const kitRows = googleWebhook.formatKitRow(processed.kit);
            for (const r of kitRows) kitBatch.push(r);
            progress.update({ stats: { kit: (progress.load().stats.kit || 0) + 1 } });
          }

          // Enviar lotes quando atingir BATCH_SIZE
          if (simpleBatch.length >= BATCH_SIZE) {
            await sendBatch('simple', simpleBatch);
            simpleBatch = [];
          }
          if (variationBatch.length >= BATCH_SIZE) {
            await sendBatch('variation', variationBatch);
            variationBatch = [];
          }
          if (kitBatch.length >= BATCH_SIZE) {
            await sendBatch('kit', kitBatch);
            kitBatch = [];
          }

          progress.markProcessed(product.id);
          logger.success(`Produto processado: ${product.nome || product.id}`);

        } catch (err) {
          logger.error(`Erro no produto ${product.id}: ${err.message}`);
          progress.addError(product.id, err.message);
          // Continua para o proximo
        }
      }

      progress.update({ lastPage: page });
      page++;

      await blingProducts.sleep(500);
    }

    // Enviar lotes restantes
    if (simpleBatch.length > 0) {
      await sendBatch('simple', simpleBatch);
    }
    if (variationBatch.length > 0) {
      await sendBatch('variation', variationBatch);
    }
    if (kitBatch.length > 0) {
      await sendBatch('kit', kitBatch);
    }

    if (importRunning) {
      progress.update({ status: 'completed' });
      logger.success('=== IMPORTACAO CONCLUIDA ===');
      const stats = progress.load().stats;
      logger.info(`Total: ${stats.processed} produtos | Simples: ${stats.simple} | Variacoes: ${stats.variation}`);
      logger.info(`Sem preco: ${stats.noPrice} | Sem SKU pai: ${stats.noParentSku} | Erros: ${progress.load().errors.length}`);
    }

  } catch (err) {
    logger.error(`Erro na importacao: ${err.message}`);
    progress.update({ status: 'error' });
  } finally {
    importRunning = false;
    importPaused = false;
  }
}

// Grava o lote de linhas em disco (.jsonl). A geracao do .xlsx da UpSeller e feita
// depois, sob demanda, em POST /api/export/xlsx.
function sendBatch(type, rows) {
  try {
    rowstore.append(type, rows);
    progress.update({ stats: { sheetsSent: progress.load().stats.sheetsSent + rows.length } });
  } catch (err) {
    logger.error(`Falha ao gravar lote ${type}: ${err.message}`);
  }
}

// ===================== SYNC EM LOTE: Bling -> Shopify =====================
const fs = require('fs');
const SYNC_PROG_PATH = path.join(__dirname, 'data', 'shopify-sync-progress.json');

function loadSyncProg() {
  try { return JSON.parse(fs.readFileSync(SYNC_PROG_PATH, 'utf8')); }
  catch (e) { return { lastPage: 0, syncedIds: [], stats: { created: 0, skipped: 0, kit: 0, errors: 0 }, errors: [] }; }
}
function saveSyncProg(p) {
  if (!fs.existsSync(path.dirname(SYNC_PROG_PATH))) fs.mkdirSync(path.dirname(SYNC_PROG_PATH), { recursive: true });
  fs.writeFileSync(SYNC_PROG_PATH, JSON.stringify(p, null, 2));
}

async function runShopifySync(opts) {
  // pausa a importacao UpSeller pra nao competir no rate limit do Bling
  if (importRunning && !importPaused) { importPaused = true; logger.warning('Sync lote: importacao UpSeller PAUSADA p/ nao competir no Bling'); }

  let sp = loadSyncProg();
  if (opts.reset) { sp = { lastPage: 0, syncedIds: [], stats: { created: 0, skipped: 0, kit: 0, errors: 0 }, errors: [] }; saveSyncProg(sp); }
  const synced = new Set(sp.syncedIds || []);
  let page = sp.lastPage > 0 ? sp.lastPage : 1;

  logger.info('=== INICIANDO SYNC EM LOTE Bling -> Shopify ===');
  await shopifyProducts.loadBwIndex(); // indexa categorias da BW uma vez

  let nesteRun = 0;
  try {
    while (shopifySyncRunning) {
      while (shopifySyncPaused && shopifySyncRunning) await blingProducts.sleep(1000);
      if (!shopifySyncRunning) break;

      let products;
      try { products = (await blingProducts.fetchProductsPage(page, 100)).data || []; }
      catch (e) { if (e.response && e.response.status === 429) { logger.warning('Bling 429: aguardando 60s'); await blingProducts.sleep(60000); continue; } throw e; }
      if (products.length === 0) { logger.success('Sync lote: fim do catalogo Bling'); break; }

      logger.info(`Sync lote: pagina ${page} (${products.length} produtos)`);
      for (const product of products) {
        if (!shopifySyncRunning) break;
        while (shopifySyncPaused && shopifySyncRunning) await blingProducts.sleep(1000);
        if (synced.has(product.id)) continue;

        let tentativa = 0, resolvido = false;
        while (!resolvido && tentativa < 4 && shopifySyncRunning) {
          tentativa++;
          try {
            const details = await blingProducts.fetchProductDetails(product.id);
            await blingProducts.sleep(300);
            const codigoPai = details.codigoPai
              || (details.estrutura && details.estrutura.pai && details.estrutura.pai.id)
              || (details.variacao && details.variacao.produtoPai && details.variacao.produtoPai.id)
              || product.idProdutoPai || null;
            if (codigoPai) { synced.add(product.id); resolvido = true; break; } // variacao-filha: processada pelo pai
            const processed = blingProducts.processProduct(product, details);
            if (processed.kit) { sp.stats.kit = (sp.stats.kit || 0) + 1; synced.add(product.id); resolvido = true; break; }
            const descricao = details.descricaoComplementar || details.descricaoCurta || details.descricao || '';
            const r = await shopifyProducts.upsertProduct(processed, { descricao, status: opts.status, update: opts.update });
            if (r.skipped) sp.stats.skipped++; else sp.stats.created++;
            synced.add(product.id); nesteRun++; resolvido = true;
          } catch (e) {
            const is429 = (e.response && e.response.status === 429) || /429/.test(e.message || '');
            if (is429 && tentativa < 4) {
              const espera = tentativa * 20000; // 20s, 40s, 60s
              logger.warning(`429 no produto ${product.id} (tentativa ${tentativa}/4) - aguardando ${espera / 1000}s`);
              await blingProducts.sleep(espera);
            } else {
              sp.stats.errors++;
              (sp.errors = sp.errors || []).push({ id: product.id, msg: e.message });
              if (sp.errors.length > 200) sp.errors = sp.errors.slice(-200);
              logger.error(`Sync lote erro produto ${product.id}: ${e.message}`);
              resolvido = true; // desiste deste produto (sera reprocessado num novo passe)
            }
          }
        }
        sp.syncedIds = Array.from(synced);
        saveSyncProg(sp);
        await blingProducts.sleep(opts.sleepMs);
      }
      sp.lastPage = page; saveSyncProg(sp);
      page++;
      logger.info(`Sync lote: lote concluido. Pausa de ${opts.pausaEntreLotesMs}ms antes do proximo lote. (criados=${sp.stats.created} pulados=${sp.stats.skipped} erros=${sp.stats.errors})`);
      await blingProducts.sleep(opts.pausaEntreLotesMs);
    }
  } catch (e) {
    logger.error(`Sync lote fatal: ${e.message}`);
  } finally {
    shopifySyncRunning = false;
    sp.syncedIds = Array.from(synced);
    saveSyncProg(sp);
    logger.success(`=== SYNC LOTE PARADO === neste run: ${nesteRun} | criados=${sp.stats.created} pulados=${sp.stats.skipped} kits=${sp.stats.kit} erros=${sp.stats.errors}`);
  }
}

// ===================== BACKFILL + AUDITORIA =====================
const AUDIT_PATH = path.join(__dirname, 'data', 'audit-report.json');
function freshAudit() { return { lastPage: 0, seen: [], checked: 0, found: 0, missing: 0, catFix: 0, problemas: { categoria: [], variantes: [], semImagem: [], semFiscal: [] }, missingList: [] }; }
function loadAuditRep() { try { return JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8')); } catch (e) { return freshAudit(); } }
function saveAuditRep(r) { if (!fs.existsSync(path.dirname(AUDIT_PATH))) fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true }); fs.writeFileSync(AUDIT_PATH, JSON.stringify(r, null, 2)); }

async function runBackfillAudit(opts) {
  if (importRunning && !importPaused) { importPaused = true; logger.warning('Auditoria: importacao UpSeller pausada'); }
  await shopifyProducts.loadBwIndex();
  let r = loadAuditRep();
  if (opts.reset) { r = freshAudit(); saveAuditRep(r); }
  const seen = new Set(r.seen || []);
  let page = r.lastPage > 0 ? r.lastPage : 1;
  logger.info('=== INICIANDO BACKFILL bling_sku + AUDITORIA Bling x Shopify ===');
  try {
    while (auditRunning) {
      let products;
      try { products = (await blingProducts.fetchProductsPage(page, 100)).data || []; }
      catch (e) { if (e.response && e.response.status === 429) { logger.warning('Bling 429: 60s'); await blingProducts.sleep(60000); continue; } throw e; }
      if (!products.length) { logger.success('Auditoria: fim do catalogo Bling'); break; }
      logger.info(`Auditoria: pagina ${page} (${products.length})`);
      for (const product of products) {
        if (!auditRunning) break;
        if (seen.has(product.id)) continue;
        try {
          const details = await blingProducts.fetchProductDetails(product.id);
          await blingProducts.sleep(250);
          const codigoPai = details.codigoPai
            || (details.estrutura && details.estrutura.pai && details.estrutura.pai.id)
            || (details.variacao && details.variacao.produtoPai && details.variacao.produtoPai.id)
            || product.idProdutoPai || null;
          if (codigoPai) { seen.add(product.id); continue; }
          const processed = blingProducts.processProduct(product, details);
          if (processed.kit) { seen.add(product.id); continue; }
          const a = await shopifyProducts.tagAndAudit(processed);
          if (a) {
            r.checked++;
            if (!a.found) { r.missing++; if (r.missingList.length < 500) r.missingList.push(a.sku); }
            else {
              r.found++;
              if (!a.catOk) { r.catFix++; if (r.problemas.categoria.length < 200) r.problemas.categoria.push(`${a.sku}: BW="${a.cat}" antes="${a.catBefore}"`); }
              if (!a.varOk && r.problemas.variantes.length < 200) r.problemas.variantes.push(`${a.sku}: esperado ${a.expVar} got ${a.gotVar}`);
              if (!a.imgOk && r.problemas.semImagem.length < 300) r.problemas.semImagem.push(a.sku);
              if (!a.fiscalOk && r.problemas.semFiscal.length < 500) r.problemas.semFiscal.push(a.sku);
            }
          }
          seen.add(product.id);
        } catch (e) { logger.error(`Auditoria erro ${product.id}: ${e.message}`); }
        r.seen = Array.from(seen);
        if (r.checked % 25 === 0) saveAuditRep(r);
        await blingProducts.sleep(opts.sleepMs || 500);
      }
      r.lastPage = page; saveAuditRep(r); page++;
      await blingProducts.sleep(opts.pausaEntreLotesMs || 3000);
    }
  } catch (e) { logger.error(`Auditoria fatal: ${e.message}`); }
  finally {
    auditRunning = false; r.seen = Array.from(seen); r.finishedAt = new Date().toISOString(); saveAuditRep(r);
    logger.success(`=== AUDITORIA PARADA === checados=${r.checked} achados=${r.found} faltando=${r.missing} catCorrigidas=${r.catFix} | semImg=${r.problemas.semImagem.length} semFiscal=${r.problemas.semFiscal.length} varDiverg=${r.problemas.variantes.length}`);
  }
}

// ===================== START =====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n================================================`);
  console.log(`  ERP-JU: Importador Bling → Google Sheets`);
  console.log(`  Servidor rodando em http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`================================================\n`);
});
