const sseClients = new Set();

function addClient(res) {
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

function broadcast(type, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    type, // 'info' | 'success' | 'error' | 'warning' | 'progress'
    message,
    ...data
  };

  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }

  // Console log tambem
  const prefix = { info: 'ℹ', success: '✓', error: '✗', warning: '⚠', progress: '→' };
  console.log(`[${entry.timestamp}] ${prefix[type] || '•'} ${message}`);

  return entry;
}

function info(msg, data) { return broadcast('info', msg, data); }
function success(msg, data) { return broadcast('success', msg, data); }
function error(msg, data) { return broadcast('error', msg, data); }
function warning(msg, data) { return broadcast('warning', msg, data); }
function progress(msg, data) { return broadcast('progress', msg, data); }

module.exports = { addClient, broadcast, info, success, error, warning, progress };
