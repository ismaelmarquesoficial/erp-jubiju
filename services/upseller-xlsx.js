const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

// Templates oficiais da UpSeller (vao no repo em templates/upseller/)
const TEMPLATE_DIR = path.join(__dirname, '..', 'templates', 'upseller');
const MAX_ROWS = 5000; // UpSeller aceita ate 5.000 SKUs por arquivo

const TEMPLATES = {
  simple:    { file: 'unico.xlsx',    sheet: 'Import_Single_Template_BR01',   cols: 20 },
  variation: { file: 'variante.xlsx', sheet: 'Import_Variants_Template_BR01',  cols: 31 }
};

// Preenche o template da UpSeller com `rows` (arrays de valores, na ordem das colunas),
// dividindo em varios arquivos de ate MAX_ROWS linhas. Preserva cabecalho, validacoes
// e a aba "Origin". Retorna [{ file, rows }].
async function generate(type, rows, outDir, baseName) {
  const conf = TEMPLATES[type];
  if (!conf) throw new Error('Tipo sem template UpSeller: ' + type);
  if (!rows || rows.length === 0) return [];

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Divide em blocos de MAX_ROWS
  const chunks = [];
  for (let i = 0; i < rows.length; i += MAX_ROWS) chunks.push(rows.slice(i, i + MAX_ROWS));

  const out = [];
  for (let part = 0; part < chunks.length; part++) {
    const chunk = chunks[part];

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(TEMPLATE_DIR, conf.file));
    const ws = wb.getWorksheet(conf.sheet) || wb.worksheets[0];

    // Limpa os valores das linhas de exemplo (mantem cabecalho na linha 1 e validacoes)
    const lastTemplateRow = ws.rowCount;
    for (let r = 2; r <= lastTemplateRow; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= conf.cols; c++) row.getCell(c).value = null;
    }

    // Escreve os dados a partir da linha 2
    chunk.forEach((vals, idx) => {
      const row = ws.getRow(idx + 2);
      for (let c = 1; c <= conf.cols; c++) {
        const v = vals[c - 1];
        row.getCell(c).value = (v === undefined || v === '') ? null : v;
      }
    });

    const suffix = part === 0 ? '' : `_${part + 1}`;
    const fileName = `${baseName}${suffix}.xlsx`;
    await wb.xlsx.writeFile(path.join(outDir, fileName));
    out.push({ file: fileName, rows: chunk.length });
  }

  return out;
}

module.exports = { generate, TEMPLATES, TEMPLATE_DIR, MAX_ROWS };
