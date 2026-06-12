/**
 * =====================================================
 * GOOGLE APPS SCRIPT - WEBHOOK PARA IMPORTADOR BLING
 * =====================================================
 *
 * INSTRUCOES:
 * 1. Acesse https://script.google.com
 * 2. Crie um novo projeto
 * 3. Cole este codigo no editor
 * 4. Substitua SPREADSHEET_ID pelo ID da sua planilha
 * 5. Substitua DRIVE_FOLDER_ID pelo ID da pasta do Drive (para imagens)
 * 6. Clique em "Implantar" > "Nova implantacao"
 * 7. Tipo: "App da Web"
 * 8. Executar como: "Eu"
 * 9. Quem tem acesso: "Qualquer pessoa"
 * 10. Copie a URL gerada e cole no .env como GOOGLE_WEBHOOK_URL
 *
 * IMPORTANTE: ao alterar este arquivo, e preciso colar de novo no editor
 * do Apps Script e criar uma NOVA IMPLANTACAO para valer no servidor.
 */

const SPREADSHEET_ID = '1UDMQ9pCa3bDJzozDKkVSKQdjrWb4RHmr1rO07qWiAgw';
const DRIVE_FOLDER_ID = '1M6Ihntq9aXmVCgvQ-tfcP0nQPO5o9Cq5';

// Limite de linhas de DADOS por aba (UpSeller aceita 5.000 SKUs por arquivo).
// Ao estourar, o script cria "Produtos Simples 2", "Produtos Simples 3", etc.
const MAX_ROWS = 5000;

// ---- Cabecalhos oficiais de cada modelo ----

const HEADERS_SIMPLE = [
  'SKU*\n(Obrigatorio, 1-200 caracteres)',
  'Titulo*\n(Obrigatorio, 1-500 caracteres)',
  'Apelido do Produto\n(1-500 caracteres)',
  'Usar apelido como titulo da NFe',
  'Preco de varejo\n(limite 0-999999999)',
  'Custo de Compra\n(limite 0-999999999)',
  'Quantidade\n(limite 0-999999999)',
  'N do Estante',
  'Codigo de Barras\n(8 a 14 caracteres)',
  'Apelido de SKU',
  'Imagem',
  'Peso (g)\n(limite 1-999999)',
  'Comprimento (cm)\n(limite 1-999999)',
  'Largura (cm)\n(limite 1-999999)',
  'Altura (cm)\n(limite 1-999999)',
  'NCM\n(8 digitos)',
  'CEST\n(7 digitos)',
  'Unidade\n(UN/KG/Par)',
  'Origem\n(0-8)',
  'Link do Fornecedor'
];

const HEADERS_VARIATION = [
  'SPU*\n(Obrigatorio, 1-200 caracteres)',
  'SKU*\n(Obrigatorio, 1-200 caracteres)',
  'Titulo*\n(Obrigatorio, 1-500 caracteres)',
  'Apelido do Produto\n(1-500 caracteres)',
  'Usar apelido como titulo da NFe',
  'Variantes1*\n(Obrigatorio, 1-14 caracteres)',
  'Valor da Variante1*\n(Obrigatorio, 1-30 caracteres)',
  'Variantes2\n(1-14 caracteres)',
  'Valor da Variante2\n(1-30 caracteres)',
  'Variantes3\n(1-14 caracteres)',
  'Valor da Variante3\n(1-30 caracteres)',
  'Variantes4\n(1-14 caracteres)',
  'Valor da Variante4\n(1-30 caracteres)',
  'Variantes5\n(1-14 caracteres)',
  'Valor da Variante5\n(1-30 caracteres)',
  'Preco de varejo\n(limite 0-999999999)',
  'Custo de Compra\n(limite 0-999999999)',
  'Quantidade\n(limite 0-999999999)',
  'N do Estante',
  'Codigo de Barras\n(8 a 14 caracteres)',
  'Apelido de SKU',
  'Imagem',
  'Peso (g)\n(limite 1-999999)',
  'Comprimento (cm)\n(limite 1-999999)',
  'Largura (cm)\n(limite 1-999999)',
  'Altura (cm)\n(limite 1-999999)',
  'NCM\n(8 digitos)',
  'CEST\n(7 digitos)',
  'Unidade\n(UN/KG/Par)',
  'Origem\n(0-8)',
  'Link do Fornecedor'
];

const HEADERS_KIT = [
  'Kit SKU*',
  'Titulo*',
  'Imagem',
  'SKU*',
  'SKU Qnt*'
];

// Mapa de tipos -> aba + cabecalho
const SHEETS = {
  simple:    { name: 'Produtos Simples',      headers: HEADERS_SIMPLE },
  variation: { name: 'Produtos com Variacao', headers: HEADERS_VARIATION },
  kit:       { name: 'Produtos KIT',          headers: HEADERS_KIT }
};

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    if (action === 'ping') {
      return jsonResponse({ status: 'ok', message: 'Webhook ativo' });
    }

    if (action === 'addProducts') {
      return handleAddProducts(data);
    }

    if (action === 'uploadImage') {
      return handleUploadImage(data);
    }

    return jsonResponse({ status: 'error', message: 'Acao desconhecida: ' + action });

  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}

function doGet(e) {
  return jsonResponse({ status: 'ok', message: 'Webhook ERP-JU ativo. Use POST para enviar dados.' });
}

// ============ PRODUTOS ============

function handleAddProducts(data) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const conf = SHEETS[data.type]; // 'simple' | 'variation' | 'kit'

  if (!conf) {
    return jsonResponse({ status: 'error', message: 'Tipo desconhecido: ' + data.type });
  }

  const rows = data.rows;
  if (!rows || rows.length === 0) {
    return jsonResponse({ status: 'ok', message: 'Nenhuma linha para adicionar' });
  }

  const sheetName = appendRowsSplit(ss, conf.name, conf.headers, rows);

  return jsonResponse({
    status: 'ok',
    message: `${rows.length} linhas adicionadas em "${conf.name}"`,
    rowsAdded: rows.length
  });
}

// Anexa linhas dividindo em abas de no maximo MAX_ROWS ("Aba", "Aba 2", "Aba 3"...).
// Observacao: um KIT pode, no limite exato de 5.000, ter componentes em abas diferentes;
// como kits sao raros, esse caso de borda e aceitavel.
function appendRowsSplit(ss, baseName, headers, rows) {
  let remaining = rows.slice();
  let part = 0;
  let lastSheetName = baseName;

  while (remaining.length > 0) {
    const sheetName = part === 0 ? baseName : baseName + ' ' + (part + 1);
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);

    ensureHeader(sheet, headers);

    const dataRows = Math.max(0, sheet.getLastRow() - 1); // exclui o cabecalho
    const capacity = MAX_ROWS - dataRows;
    if (capacity <= 0) { part++; continue; }

    const chunk = remaining.splice(0, capacity);
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, chunk.length, chunk[0].length).setValues(chunk);

    lastSheetName = sheetName;
    part++;
  }

  return lastSheetName;
}

// Garante o cabecalho correto na linha 1.
// Se a linha 1 tiver um DADO (ex.: "CONJ396"), insere o cabecalho acima sem apagar nada.
function ensureHeader(sheet, headers) {
  const expectedKey = String(headers[0]).split('\n')[0]; // 'SKU*' | 'SPU*' | 'Kit SKU*'

  if (sheet.getLastRow() === 0) {
    writeHeader(sheet, headers);
    return;
  }

  const a1 = String(sheet.getRange(1, 1).getValue()).split('\n')[0];
  if (a1 !== expectedKey) {
    sheet.insertRowBefore(1);
    writeHeader(sheet, headers);
  }
}

function writeHeader(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

// ============ IMAGENS ============

function handleUploadImage(data) {
  const fileName = data.fileName;
  const mimeType = data.mimeType || 'image/jpeg';
  const imageData = data.imageData; // base64
  const folderId = data.folderId || DRIVE_FOLDER_ID;

  if (!imageData) {
    return jsonResponse({ status: 'error', message: 'Sem dados de imagem' });
  }

  try {
    const blob = Utilities.newBlob(
      Utilities.base64Decode(imageData),
      mimeType,
      fileName
    );

    let file;
    if (folderId) {
      const folder = DriveApp.getFolderById(folderId);
      file = folder.createFile(blob);
    } else {
      file = DriveApp.createFile(blob);
    }

    // Tornar acessivel por link
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const fileId = file.getId();
    const url = `https://drive.google.com/uc?export=view&id=${fileId}`;

    return jsonResponse({
      status: 'ok',
      url: url,
      fileId: fileId,
      fileName: fileName
    });

  } catch (err) {
    return jsonResponse({ status: 'error', message: 'Erro ao upload: ' + err.toString() });
  }
}

// ============ UTILS ============

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
