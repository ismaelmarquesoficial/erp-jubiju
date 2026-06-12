const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Pasta onde as imagens ficam salvas no servidor.
// Por padrao public/imagens (servida estaticamente). Em producao (EasyPanel),
// aponte IMAGES_DIR para um VOLUME PERSISTENTE, senao um redeploy apaga tudo.
const IMAGES_DIR = process.env.IMAGES_DIR
  ? path.resolve(process.env.IMAGES_DIR)
  : path.join(__dirname, '..', 'public', 'imagens');

// Base publica do servidor (ex.: https://hospedagem-erp-ju.g0rat2.easypanel.host).
// Necessaria porque a planilha/UpSeller precisa de URL ABSOLUTA da imagem.
function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

// Baixa imagem de uma URL e retorna o buffer
async function downloadImage(imageUrl) {
  if (!imageUrl) return null;

  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const buffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || 'image/jpeg';

    return { buffer, mimeType: contentType, size: buffer.length };
  } catch (err) {
    logger.warning(`Falha ao baixar imagem ${imageUrl}: ${err.message}`);
    return null;
  }
}

// Baixa UMA imagem (link temporario do Bling) e salva na pasta publica do servidor.
// Retorna a URL publica permanente; se falhar, devolve o link original como fallback.
async function processProductImage(imageUrl, sku, productName, index = 0) {
  if (!imageUrl) return '';

  try {
    const imageData = await downloadImage(imageUrl);
    if (!imageData) return imageUrl;

    const ext = getExtension(imageData.mimeType);
    const safeSku = (sku || 'sem-sku').replace(/[^a-zA-Z0-9-_]/g, '_');
    const suffix = index > 0 ? `_${index + 1}` : '';
    const fileName = `${safeSku}${suffix}.${ext}`;

    if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.writeFileSync(path.join(IMAGES_DIR, fileName), imageData.buffer);

    logger.info(`Imagem salva: imagens/${fileName} (${(imageData.size / 1024).toFixed(1)}KB)`);

    const base = publicBaseUrl();
    if (!base) {
      logger.warning('PUBLIC_BASE_URL nao configurada no .env — a URL da imagem ficara relativa e pode nao abrir na planilha/UpSeller.');
    }
    return `${base}/imagens/${fileName}`;
  } catch (err) {
    logger.warning(`Erro ao salvar imagem para ${sku}: ${err.message}`);
    return imageUrl;
  }
}

// Baixa varias imagens e retorna as URLs publicas separadas por virgula
async function processMultipleImages(imageUrls, sku, productName) {
  if (!imageUrls || imageUrls.length === 0) return '';

  const urls = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const url = await processProductImage(imageUrls[i], sku, productName, i);
    if (url) urls.push(url);
  }

  return urls.join(',');
}

function getExtension(mimeType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp'
  };
  const clean = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return map[clean] || 'jpg';
}

module.exports = { IMAGES_DIR, downloadImage, processProductImage, processMultipleImages };
