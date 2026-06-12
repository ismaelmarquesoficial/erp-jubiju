require('dotenv').config();
const express = require('express');
const path = require('path');
const blingAuth = require('./services/bling-auth');
const blingProducts = require('./services/bling-products');
const googleWebhook = require('./services/google-webhook');
const imageHandler = require('./services/image-handler');
const upsellerXlsx = require('./services/upseller-xlsx');
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
  const BATCH_SIZE = 5; // Enviar em lotes de 5

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

// ===================== START =====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n================================================`);
  console.log(`  ERP-JU: Importador Bling → Google Sheets`);
  console.log(`  Servidor rodando em http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`================================================\n`);
});
