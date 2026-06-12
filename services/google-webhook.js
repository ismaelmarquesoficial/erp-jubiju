const axios = require('axios');
const logger = require('../utils/logger');

// Google Apps Script redireciona POST (302). Axios converte POST→GET no redirect,
// perdendo o body. Solucao: pegar a URL de redirect e re-POST nela.
async function postToWebhook(data, timeout = 30000) {
  const webhookUrl = process.env.GOOGLE_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('GOOGLE_WEBHOOK_URL nao configurada no .env');

  const jsonData = JSON.stringify(data);

  try {
    // Primeira tentativa: POST direto seguindo redirects
    const response = await axios.post(webhookUrl, jsonData, {
      headers: { 'Content-Type': 'application/json' },
      timeout,
      maxRedirects: 0, // Nao seguir redirect automaticamente
      validateStatus: () => true // Aceitar qualquer status
    });

    // Se recebeu redirect (302/307), seguir com GET para ler a resposta
    // O Apps Script ja processou os dados no POST original
    if (response.status === 302 || response.status === 301 || response.status === 307) {
      const redirectUrl = response.headers.location;
      if (redirectUrl) {
        const finalResponse = await axios.get(redirectUrl, {
          timeout,
          maxRedirects: 5,
          validateStatus: () => true
        });
        return parseResponse(finalResponse);
      }
    }

    // Se nao teve redirect, resposta direta
    return parseResponse(response);

  } catch (err) {
    // Fallback: tentar com fetch nativo (Node 18+)
    try {
      logger.info('Tentando com fetch nativo...');
      const fetchResponse = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonData,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout)
      });
      const text = await fetchResponse.text();
      try {
        return JSON.parse(text);
      } catch {
        return { status: 'ok', raw: text };
      }
    } catch (fetchErr) {
      throw new Error(`Webhook falhou: axios(${err.message}) fetch(${fetchErr.message})`);
    }
  }
}

function parseResponse(response) {
  if (typeof response.data === 'string') {
    try { return JSON.parse(response.data); } catch { return { raw: response.data }; }
  }
  return response.data;
}

// Envia dados para o Google Apps Script webhook
async function sendToSheets(type, rows) {
  logger.info(`Enviando ${rows.length} produto(s) ${type} para Google Sheets...`);

  const result = await postToWebhook({
    action: 'addProducts',
    type,
    rows
  });

  if (result && result.status === 'ok') {
    logger.success(`${rows.length} produto(s) ${type} enviados para Google Sheets`);
    return true;
  } else {
    logger.error(`Erro no webhook Sheets: ${JSON.stringify(result)}`);
    return false;
  }
}

// Upload de imagem via Apps Script (base64)
async function uploadImageToDrive(imageBase64, fileName, mimeType) {
  try {
    const result = await postToWebhook({
      action: 'uploadImage',
      fileName,
      mimeType,
      imageData: imageBase64,
      folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || ''
    }, 60000);

    if (result && result.url) {
      return result.url;
    }
    return null;
  } catch (err) {
    logger.error(`Falha ao upload imagem "${fileName}": ${err.message}`);
    return null;
  }
}

// Testa conexao com o webhook
async function testConnection() {
  const webhookUrl = process.env.GOOGLE_WEBHOOK_URL;
  if (!webhookUrl) return { connected: false, error: 'URL nao configurada' };

  try {
    const result = await postToWebhook({ action: 'ping' }, 10000);
    return { connected: true, response: result };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

// Formata produto simples para linha da planilha
function formatSimpleRow(product) {
  return [
    product.sku || '',
    product.titulo || '',
    product.apelido || '',
    product.usarApelidoNfe || 'N',
    product.precoVarejo || '',
    product.custoCompra || '',
    product.quantidade || '',
    product.estante || '',
    product.codigoBarras || '',
    product.apelidoSku || '',
    product.imagem || '',
    product.peso || '',
    product.comprimento || '',
    product.largura || '',
    product.altura || '',
    product.ncm || '',
    product.cest || '',
    product.unidade || 'UN',
    product.origem || '',
    product.linkFornecedor || ''
  ];
}

// Formata produto com variacao para linha da planilha
function formatVariationRow(variation) {
  const attrs = variation.variantes || [];
  const row = [
    variation.spu,
    variation.sku,
    variation.titulo,
    variation.apelido,
    variation.usarApelidoNfe
  ];

  // Adiciona ate 5 pares de variantes
  for (let i = 0; i < 5; i++) {
    if (attrs[i]) {
      row.push(attrs[i].name);
      row.push(attrs[i].value);
    } else {
      row.push('');
      row.push('');
    }
  }

  row.push(
    variation.precoVarejo || '',
    variation.custoCompra || '',
    variation.quantidade || '',
    variation.estante || '',
    variation.codigoBarras || '',
    variation.apelidoSku || '',
    variation.imagem || '',
    variation.peso || '',
    variation.comprimento || '',
    variation.largura || '',
    variation.altura || '',
    variation.ncm || '',
    variation.cest || '',
    variation.unidade || 'UN',
    variation.origem || '',
    variation.linkFornecedor || ''
  );

  return row;
}

// Formata um KIT: retorna VARIAS linhas (uma por componente).
// A primeira linha traz Kit SKU/Titulo/Imagem; as demais deixam esses campos vazios.
function formatKitRow(kit) {
  const comps = kit.componentes || [];
  const imagem = kit.imagem || (Array.isArray(kit.imagens) ? (kit.imagens[0] || '') : '') || '';

  if (comps.length === 0) {
    return [[kit.kitSku || '', kit.titulo || '', imagem, '', '']];
  }

  return comps.map((c, i) => {
    if (i === 0) return [kit.kitSku || '', kit.titulo || '', imagem, c.sku || '', c.qtd || ''];
    return ['', '', '', c.sku || '', c.qtd || ''];
  });
}

module.exports = {
  sendToSheets,
  uploadImageToDrive,
  testConnection,
  formatSimpleRow,
  formatVariationRow,
  formatKitRow
};
