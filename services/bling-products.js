const axios = require('axios');
const fs = require('fs');
const path = require('path');
const blingAuth = require('./bling-auth');
const logger = require('../utils/logger');

const API_BASE = 'https://api.bling.com.br/Api/v3';
let debugSaved = false;
let kitDebugSaved = false;

async function apiGet(endpoint, params = {}) {
  const token = await blingAuth.getValidAccessToken();
  const response = await axios.get(`${API_BASE}${endpoint}`, {
    headers: { 'Authorization': `Bearer ${token}` },
    params
  });
  return response.data;
}

// Busca lista de produtos com paginacao
async function fetchProductsPage(page = 1, limit = 100) {
  const data = await apiGet('/produtos', {
    pagina: page,
    limite: limit
  });
  return data;
}

// Lista TODOS os codigos do Bling via paginacao da lista (sem detalhes -> rapido).
// Retorna [{ c: codigo, id, pai: idProdutoPai|null }]. Inclui variacoes-filhas (elas aparecem na lista).
async function fetchAllCodigos() {
  const out = [];
  let page = 1;
  while (true) {
    const data = await apiGet('/produtos', { pagina: page, limite: 100 });
    const arr = data.data || [];
    if (!arr.length) break;
    for (const p of arr) out.push({ c: p.codigo, id: p.id, pai: p.idProdutoPai || null });
    page++;
    await sleep(300);
  }
  return out;
}

// Busca produto(s) no Bling pelo codigo exato (SKU). Retorna array de itens da lista (com .id).
async function fetchByCodigo(codigo) {
  const data = await apiGet('/produtos', { codigo: String(codigo || '').trim(), limite: 10 });
  return data.data || [];
}

// Busca detalhes de um produto especifico
async function fetchProductDetails(productId) {
  const data = await apiGet(`/produtos/${productId}`);
  const product = data.data || data;

  // Salvar debug dos primeiros produtos para analise
  if (!debugSaved) {
    debugSaved = true;
    const debugPath = path.join(__dirname, '..', 'data', 'debug-product.json');
    const dir = path.dirname(debugPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(debugPath, JSON.stringify(product, null, 2));

    const formato = product.formato || '?';
    const tipo = product.tipo || '?';
    const temVariacoes = product.variacoes && product.variacoes.length > 0;
    const codigoPai = product.codigoPai || product.estrutura?.pai?.id || 'nenhum';
    logger.info(`DEBUG: produto salvo | formato=${formato} | tipo=${tipo} | variacoes=${temVariacoes} | codigoPai=${codigoPai}`);
    logger.info(`DEBUG: campos: ${Object.keys(product).join(', ')}`);
    if (temVariacoes && product.variacoes[0]) {
      logger.info(`DEBUG: campos variacao[0]: ${Object.keys(product.variacoes[0]).join(', ')}`);
    }
  }

  return product;
}

// Busca estoque de um produto
async function fetchProductStock(productId) {
  try {
    const data = await apiGet(`/estoques/saldos`, { idsProdutos: [productId] });
    return data.data || data;
  } catch {
    return null;
  }
}

// Busca todos os produtos com todas as paginas
async function fetchAllProducts(onPage, startPage = 1) {
  let page = startPage;
  let allProducts = [];
  let hasMore = true;

  while (hasMore) {
    logger.info(`Buscando pagina ${page} de produtos do Bling...`);
    try {
      const response = await fetchProductsPage(page, 100);
      const products = response.data || [];
      if (products.length === 0) { hasMore = false; break; }
      allProducts = allProducts.concat(products);
      if (onPage) await onPage(products, page);
      logger.success(`Pagina ${page}: ${products.length} produtos encontrados`);
      page++;
      await sleep(500);
    } catch (err) {
      if (err.response && err.response.status === 429) {
        logger.warning('Rate limit atingido. Aguardando 60s...');
        await sleep(60000);
        continue;
      }
      throw err;
    }
  }
  return allProducts;
}

// Processa um produto e retorna dados formatados
function processProduct(product, productDetails) {
  const d = productDetails || product;

  // Bling v3: formato S=Simples, V=Com variacoes, E=Componente
  // Tambem checar se tem variacoes no array
  const hasVariations = (d.formato === 'V' || d.tipo === 'V') ||
    (d.variacoes && Array.isArray(d.variacoes) && d.variacoes.length > 0);

  const result = {
    id: d.id,
    hasVariations,
    alerts: [],
    simple: null,
    variations: [],
    kit: null
  };

  // KIT tem prioridade: produto com composicao/estrutura vira kit.
  // A deteccao e SEMPRE pela estrutura (nunca pelo nome "Kit...", que da falso positivo).
  const kitComponents = getKitComponents(d);
  if (kitComponents.length > 0) {
    logKitDebug(d);
    result.kit = {
      kitSku: safe(d.codigo) || `KIT-${d.id}`,
      titulo: safe(d.nome) || '',
      imagens: getAllImageUrls(null, d),
      componentes: kitComponents
    };
    return result;
  }

  if (hasVariations && d.variacoes && d.variacoes.length > 0) {
    const parentSku = safe(d.codigo);
    const parentName = safe(d.nome);

    for (let idx = 0; idx < d.variacoes.length; idx++) {
      const v = d.variacoes[idx];

      // SKU da variante
      let varSku = safe(v.codigo);
      if (!varSku) {
        varSku = `${parentSku || 'PROD'}-V${idx + 1}`;
        result.alerts.push({
          type: 'noParentSku',
          message: `Variante idx ${idx} do produto "${parentName}" sem SKU proprio`
        });
      }

      // Checar se variante tem referencia do pai
      if (!parentSku) {
        result.alerts.push({
          type: 'noParentSku',
          message: `Variante SKU "${varSku}" sem info do produto-pai (pai sem codigo)`
        });
      }

      // Preco
      let preco = num(v.preco) || num(d.preco) || 0;
      if (preco <= 0) {
        preco = 0.01;
        result.alerts.push({
          type: 'noPrice',
          message: `Variante "${varSku}" sem preco - definido como 0.01`
        });
      }

      // Atributos de variacao
      const variantAttrs = parseVariationAttributes(v, d);

      result.variations.push({
        spu: parentSku,
        sku: varSku,
        titulo: parentName,
        apelido: parentName.substring(0, 500),
        usarApelidoNfe: 'N',
        variantes: variantAttrs,
        precoVarejo: preco,
        custoCompra: getCusto(v, d, product),
        quantidade: clampEstoque(getEstoque(v) || getEstoque(d)),
        estante: '',
        codigoBarras: safe(v.gtin || v.gtinEmbalagem) || '',
        apelidoSku: '',
        imagens: getAllImageUrls(v, d),
        peso: getPeso(v, d),
        comprimento: getDimensao(v, d, 'comprimento', 'profundidade', 'profundidadeProduto'),
        largura: getDimensao(v, d, 'largura', 'larguraProduto'),
        altura: getDimensao(v, d, 'altura', 'alturaProduto'),
        ncm: getNcm(v, d),
        cest: getCest(v, d),
        unidade: mapUnidade(v.unidade || d.unidade),
        origem: getOrigem(v, d),
        linkFornecedor: ''
      });
    }
  } else {
    // Produto simples (sem variacoes)
    let preco = num(d.preco) || 0;
    if (preco <= 0) {
      preco = 0.01;
      result.alerts.push({
        type: 'noPrice',
        message: `Produto "${safe(d.codigo)}" sem preco - definido como 0.01`
      });
    }

    result.simple = {
      sku: safe(d.codigo) || `PROD-${d.id}`,
      titulo: safe(d.nome) || '',
      apelido: safe(d.nome).substring(0, 500),
      usarApelidoNfe: 'N',
      precoVarejo: preco,
      custoCompra: getCusto(d, product),
      quantidade: clampEstoque(getEstoque(d)),
      estante: '',
      codigoBarras: safe(d.gtin || d.gtinEmbalagem) || '',
      apelidoSku: '',
      imagens: getAllImageUrls(null, d),
      peso: getPeso(null, d),
      comprimento: getDimensao(null, d, 'comprimento', 'profundidade', 'profundidadeProduto'),
      largura: getDimensao(null, d, 'largura', 'larguraProduto'),
      altura: getDimensao(null, d, 'altura', 'alturaProduto'),
      ncm: getNcm(null, d),
      cest: getCest(null, d),
      unidade: mapUnidade(d.unidade),
      origem: getOrigem(null, d),
      linkFornecedor: ''
    };
  }

  return result;
}

// ============ PARSING DE VARIACOES ============

function parseVariationAttributes(variacao, parent) {
  const attrs = [];

  // Bling v3: variacao.variacao pode ser objeto, array de objetos, ou string
  const varField = variacao.variacao;

  // Caso 0 (formato REAL Bling v3): variacao.variacao = { nome: "Cor:Fundo Preto", ordem, produtoPai }
  // O atributo e o valor vem juntos numa string; multiatributo = "Cor:Azul;Tamanho:M".
  if (varField && typeof varField === 'object' && typeof varField.nome === 'string' && varField.nome.includes(':')) {
    const parsed = parseAttrString(varField.nome);
    if (parsed.length > 0) return parsed;
  }

  // Caso 1: objeto unico { nome: "Cor", valor: "Azul" }
  if (varField && typeof varField === 'object' && !Array.isArray(varField)) {
    if (varField.nome && varField.valor) {
      attrs.push(makeAttr(varField.nome, varField.valor));
    }
    // Pode ter sub-campos adicionais
    if (varField.nome2 && varField.valor2) {
      attrs.push(makeAttr(varField.nome2, varField.valor2));
    }
    if (attrs.length > 0) return attrs;
  }

  // Caso 2: array [ { nome: "Cor", valor: "Azul" }, { nome: "Tamanho", valor: "M" } ]
  if (Array.isArray(varField)) {
    for (const v of varField) {
      if (v && v.nome && v.valor) {
        attrs.push(makeAttr(v.nome, v.valor));
      }
    }
    if (attrs.length > 0) return attrs;
  }

  // Caso 3: string "Cor:Azul;Tamanho:M"
  if (typeof varField === 'string' && varField.includes(':')) {
    const parts = varField.split(';').filter(Boolean);
    for (const part of parts) {
      const [key, ...rest] = part.split(':');
      const value = rest.join(':');
      if (key && value) {
        attrs.push(makeAttr(key, value));
      }
    }
    if (attrs.length > 0) return attrs;
  }

  // Caso 4: variacao tem campo 'variacoes' (Bling v3 pode aninhar)
  if (variacao.variacoes && Array.isArray(variacao.variacoes)) {
    for (const v of variacao.variacoes) {
      const n = v.nome || v.name || v.atributo;
      const val = v.valor || v.value;
      if (n && val) {
        attrs.push(makeAttr(n, val));
      }
    }
    if (attrs.length > 0) return attrs;
  }

  // Caso 5: Tentar extrair do nome da variacao (ex: "Produto - Cor:Azul")
  const nome = safe(variacao.nome || '');
  if (nome) {
    // Tentar "Nome:Valor" no nome
    const colonMatch = nome.match(/(\w+):(.+?)(?:;|$)/g);
    if (colonMatch) {
      for (const m of colonMatch) {
        const [k, ...rest] = m.split(':');
        const val = rest.join(':').replace(';', '');
        if (k && val) {
          attrs.push(makeAttr(k, val));
        }
      }
      if (attrs.length > 0) return attrs;
    }

    // Tentar "Produto - Valor"
    const dashIdx = nome.lastIndexOf(' - ');
    if (dashIdx > 0) {
      const varPart = nome.substring(dashIdx + 3).trim();
      if (varPart) {
        attrs.push({ name: 'Variacao', value: normalizarAtributoValor(varPart) });
        return attrs;
      }
    }
  }

  // Fallback: pegar do nome do pai vs nome da variacao
  const parentName = safe(parent?.nome || '');
  if (nome && parentName && nome !== parentName) {
    const diff = nome.replace(parentName, '').replace(/^[\s\-–]+/, '').trim();
    if (diff) {
      attrs.push({ name: 'Variacao', value: normalizarAtributoValor(diff) });
    }
  }

  return attrs;
}

// ============ IMAGENS ============

// Retorna TODAS as URLs de imagem de um objeto
function extractAllImages(obj) {
  if (!obj) return [];
  const urls = [];

  // midia.imagens.externas (Bling v3 padrao)
  if (obj.midia?.imagens?.externas && Array.isArray(obj.midia.imagens.externas)) {
    for (const img of obj.midia.imagens.externas) {
      const url = img.link || img.url || '';
      if (url && !urls.includes(url)) urls.push(url);
    }
  }

  // midia.imagens.internas
  if (obj.midia?.imagens?.internas && Array.isArray(obj.midia.imagens.internas)) {
    for (const img of obj.midia.imagens.internas) {
      const url = img.link || img.url || '';
      if (url && !urls.includes(url)) urls.push(url);
    }
  }

  // imagemURL
  if (obj.imagemURL && !urls.includes(obj.imagemURL)) urls.push(obj.imagemURL);

  // imagem (string ou array)
  if (typeof obj.imagem === 'string' && obj.imagem && !urls.includes(obj.imagem)) {
    urls.push(obj.imagem);
  }
  if (Array.isArray(obj.imagem)) {
    for (const img of obj.imagem) {
      const url = typeof img === 'string' ? img : (img.link || img.url || '');
      if (url && !urls.includes(url)) urls.push(url);
    }
  }

  // imagens (array)
  if (Array.isArray(obj.imagens)) {
    for (const img of obj.imagens) {
      const url = img.link || img.url || img.href || (typeof img === 'string' ? img : '');
      if (url && !urls.includes(url)) urls.push(url);
    }
  }

  // imagensThumbnail
  if (Array.isArray(obj.imagensThumbnail)) {
    for (const img of obj.imagensThumbnail) {
      const url = img.link || img.url || '';
      if (url && !urls.includes(url)) urls.push(url);
    }
  }

  return urls;
}

// Retorna array de URLs de imagem (variacao + fallback produto pai)
function getAllImageUrls(variacao, product) {
  // Pegar imagens da variacao
  let urls = variacao ? extractAllImages(variacao) : [];

  // Se variacao nao tem imagem, pegar do produto pai
  if (urls.length === 0 && product) {
    urls = extractAllImages(product);
  }

  return urls;
}

// ============ CAMPOS AUXILIARES ============

function getEstoque(obj) {
  if (!obj) return '';
  // Bling v3 pode ter estoque em diferentes caminhos
  if (obj.estoque !== undefined && obj.estoque !== null) {
    if (typeof obj.estoque === 'number') return obj.estoque;
    if (obj.estoque.saldoVirtualTotal !== undefined) return obj.estoque.saldoVirtualTotal;
    if (obj.estoque.saldoFisicoTotal !== undefined) return obj.estoque.saldoFisicoTotal;
    if (obj.estoque.quantidade !== undefined) return obj.estoque.quantidade;
    if (obj.estoque.minimo !== undefined) return obj.estoque.minimo;
  }
  if (obj.estoqueAtual !== undefined) return obj.estoqueAtual;
  if (obj.quantidade !== undefined) return obj.quantidade;
  return '';
}

function getPeso(variacao, product) {
  // Peso em gramas (Bling pode retornar em kg, converter)
  const obj = variacao || product;
  let peso = num(obj?.pesoBruto) || num(obj?.pesoLiquido) || num(product?.pesoBruto) || num(product?.pesoLiquido) || 0;
  if (peso <= 0) return '';
  // Se peso < 100, provavelmente esta em kg, converter para gramas
  if (peso < 100) peso = Math.round(peso * 1000);
  return peso > 0 && peso <= 999999 ? peso : '';
}

function getDimensao(variacao, product, ...fieldNames) {
  for (const name of fieldNames) {
    // Checar na variacao
    if (variacao) {
      if (variacao[name] !== undefined && num(variacao[name]) > 0) return num(variacao[name]);
      if (variacao.dimensoes?.[name] !== undefined && num(variacao.dimensoes[name]) > 0) return num(variacao.dimensoes[name]);
    }
    // Checar no produto
    if (product) {
      if (product[name] !== undefined && num(product[name]) > 0) return num(product[name]);
      if (product.dimensoes?.[name] !== undefined && num(product.dimensoes[name]) > 0) return num(product.dimensoes[name]);
    }
  }
  return '';
}

function getNcm(variacao, product) {
  const sources = [variacao, product];
  for (const obj of sources) {
    if (!obj) continue;
    // Caminhos possiveis
    const ncm = obj.ncm
      || obj.tributacao?.ncm
      || obj.camposFiscais?.ncm
      || obj.fiscal?.ncm
      || obj.impostos?.ncm
      || '';
    if (ncm) return String(ncm).replace(/\D/g, '').substring(0, 8);
  }
  return '';
}

function getCest(variacao, product) {
  const sources = [variacao, product];
  for (const obj of sources) {
    if (!obj) continue;
    const cest = obj.cest
      || obj.tributacao?.cest
      || obj.camposFiscais?.cest
      || obj.fiscal?.cest
      || '';
    if (cest) return String(cest).replace(/\D/g, '').substring(0, 7);
  }
  return '';
}

// Textos EXATOS do dropdown "Origin" do template da UpSeller (precisam bater 100%)
const ORIGEM_MAP = {
  0: '0 - Nacional, exceto as indicadas nos códigos 3, 4, 5 e 8',
  1: '1 - Estrangeira - Importação direta, exceto a indicada no código 6',
  2: '2 - Estrangeira - Adquirida no mercado interno, exceto a indicada no código 7',
  3: '3 - Nacional, mercadoria ou bem com Conteúdo de Importação superior a 40% e inferior ou igual a 70%',
  4: '4 - Nacional, cuja produção tenha sido feita em conformidade com os processos produtivos básicos de que tratam as legislações citadas nos Ajustes',
  5: '5 - Nacional, mercadoria ou bem com Conteúdo de Importação inferior ou igual a 40%',
  6: '6 - Estrangeira - Importação direta, sem similar nacional, constante em lista da CAMEX e gás natural',
  7: '7 - Estrangeira - Adquirida no mercado interno, sem similar nacional, constante lista CAMEX e gás natural',
  8: '8 - Nacional, mercadoria ou bem com Conteúdo de Importação superior a 70%'
};

function getOrigem(variacao, product) {
  const sources = [variacao, product];
  for (const obj of sources) {
    if (!obj) continue;
    const origem = obj.origem
      ?? obj.tributacao?.origem
      ?? obj.camposFiscais?.origem
      ?? obj.fiscal?.origem
      ?? undefined;
    if (origem !== undefined && origem !== null) {
      const code = parseInt(origem);
      return ORIGEM_MAP[code] || String(origem);
    }
  }
  return '';
}

function mapUnidade(unidade) {
  if (!unidade) return 'UN';
  const u = String(unidade).toUpperCase().trim();
  if (u === 'KG' || u === 'KILO' || u === 'QUILOGRAMA') return 'KG';
  if (u === 'PAR' || u === 'PR') return 'Par';
  return 'UN';
}

// ============ UTILS ============

function safe(val) {
  if (val === null || val === undefined) return '';
  return String(val);
}

function num(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ NORMALIZACAO (exigencias UpSeller) ============

// Custo sempre numero >= 0,01 (UpSeller recusa custo vazio/zero).
// No Bling v3 o custo real costuma vir em fornecedor.precoCusto; o precoCusto de
// topo no detalhe da variacao vem 0. Por isso checamos os dois caminhos, em ordem.
function getCusto(...objs) {
  for (const o of objs) {
    if (!o) continue;
    const direto = num(o.precoCusto);
    if (direto > 0) return direto;
    const forn = num(o.fornecedor && o.fornecedor.precoCusto);
    if (forn > 0) return forn;
  }
  return 0.01;
}

// Estoque nunca negativo; mantem vazio quando desconhecido
function clampEstoque(val) {
  if (val === '' || val === null || val === undefined) return '';
  const n = Number(val);
  if (isNaN(n)) return '';
  return n < 0 ? 0 : n;
}

// Title Case basico para padronizar atributos de variante
function tituloCase(s) {
  return String(s || '').trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// Padroniza o NOME do atributo (resolve Cor/COR/Cord, Tam -> Tamanho)
function normalizarAtributoNome(nome) {
  let n = tituloCase(nome);
  if (/^cor/i.test(n)) n = 'Cor';
  else if (/^tam/i.test(n)) n = 'Tamanho';
  else if (/^letra/i.test(n)) n = 'Letra';
  return n.slice(0, 14);
}

// Padroniza o VALOR do atributo. Tamanhos curtos (P, M, GG, XG...) ficam em maiusculo;
// o resto vira Title Case para unificar (resolve Ouro/OURO)
function normalizarAtributoValor(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.length <= 3 && /^[a-zA-Z]+$/.test(s)) return s.toUpperCase().slice(0, 30);
  return tituloCase(s).slice(0, 30);
}

function makeAttr(name, value) {
  return { name: normalizarAtributoNome(name), value: normalizarAtributoValor(value) };
}

// Quebra "Cor:Azul;Tamanho:M" (ou "Cor:Fundo Preto") em pares de atributo normalizados
function parseAttrString(str) {
  const out = [];
  const parts = String(str || '').split(';').filter(Boolean);
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const name = part.slice(0, idx);
    const value = part.slice(idx + 1);
    if (name && value) out.push(makeAttr(name, value));
  }
  return out;
}

// Extrai os componentes de um KIT/composicao do Bling (varios formatos possiveis de campo)
function getKitComponents(d) {
  if (!d) return [];
  const candidates = [
    d.estrutura && d.estrutura.componentes,
    d.estrutura && d.estrutura.itens,
    d.composicao && d.composicao.componentes,
    d.componentes,
    Array.isArray(d.estrutura) ? d.estrutura : null,
    d.kit && d.kit.componentes,
    Array.isArray(d.kit) ? d.kit : null
  ];

  let arr = null;
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) { arr = c; break; }
  }
  if (!arr) return [];

  const comps = [];
  for (const c of arr) {
    const prod = c.produto || c.componente || {};
    const sku = safe(c.codigo || c.sku || prod.codigo || prod.sku || '');
    const qtd = num(c.quantidade != null ? c.quantidade : (c.qtd != null ? c.qtd : 1)) || 1;
    if (sku) comps.push({ sku, qtd });
  }
  return comps;
}

// Salva o JSON cru do primeiro KIT detectado, para confirmar o nome do campo de estrutura
function logKitDebug(d) {
  if (kitDebugSaved) return;
  kitDebugSaved = true;
  try {
    const p = path.join(__dirname, '..', 'data', 'debug-kit.json');
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
  } catch (e) { /* ignore */ }
  logger.info(`DEBUG KIT detectado: ${safe(d.codigo)} | campos: ${Object.keys(d).join(', ')}`);
}

module.exports = {
  fetchProductsPage,
  fetchAllCodigos,
  fetchByCodigo,
  fetchProductDetails,
  fetchProductStock,
  fetchAllProducts,
  processProduct,
  sleep
};
