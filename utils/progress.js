const fs = require('fs');
const path = require('path');

const PROGRESS_PATH = path.join(__dirname, '..', 'data', 'progress.json');

function getDefault() {
  return {
    status: 'idle', // idle | running | paused | completed | error
    lastPage: 0,
    processedIds: [],
    errors: [],
    stats: {
      total: 0,
      processed: 0,
      simple: 0,
      variation: 0,
      kit: 0,
      noPrice: 0,
      noParentSku: 0,
      imageUploaded: 0,
      sheetsSent: 0
    },
    startedAt: null,
    updatedAt: null
  };
}

function load() {
  if (!fs.existsSync(PROGRESS_PATH)) return getDefault();
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
  } catch {
    return getDefault();
  }
}

function save(data) {
  const dir = path.dirname(PROGRESS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(data, null, 2));
}

function update(changes) {
  const current = load();
  const updated = { ...current, ...changes };
  if (changes.stats) {
    updated.stats = { ...current.stats, ...changes.stats };
  }
  save(updated);
  return updated;
}

function markProcessed(productId) {
  const data = load();
  if (!data.processedIds.includes(productId)) {
    data.processedIds.push(productId);
    data.stats.processed = data.processedIds.length;
    save(data);
  }
}

function isProcessed(productId) {
  const data = load();
  return data.processedIds.includes(productId);
}

function addError(productId, errorMsg) {
  const data = load();
  data.errors.push({
    productId,
    error: errorMsg,
    timestamp: new Date().toISOString()
  });
  save(data);
}

function reset() {
  save(getDefault());
}

module.exports = { load, save, update, markProcessed, isProcessed, addError, reset };
