const fs = require('fs');
const path = require('path');

// Guarda as linhas processadas em disco (.jsonl) enquanto a importacao roda.
// Assim a geracao do .xlsx fica desacoplada do fetch lento do Bling e sobrevive a crash.
const DIR = path.join(__dirname, '..', 'data');
const TYPES = ['simple', 'variation', 'kit'];

function file(type) {
  return path.join(DIR, `out-${type}.jsonl`);
}

function append(type, rows) {
  if (!rows || rows.length === 0) return;
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  const data = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(file(type), data);
}

function read(type) {
  const f = file(type);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function count(type) {
  const f = file(type);
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
}

function clear() {
  for (const t of TYPES) {
    try { fs.unlinkSync(file(t)); } catch (e) { /* nao existe */ }
  }
}

module.exports = { append, read, count, clear, TYPES };
