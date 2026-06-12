const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TOKENS_PATH = path.join(__dirname, '..', 'data', 'tokens.json');

function getBasicAuth() {
  const clientId = process.env.BLING_CLIENT_ID;
  const clientSecret = process.env.BLING_CLIENT_SECRET;
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

function getAuthorizeUrl() {
  const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  return {
    url: `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${process.env.BLING_CLIENT_ID}&state=${state}`,
    state
  };
}

async function exchangeCodeForTokens(code) {
  const response = await axios.post('https://api.bling.com.br/Api/v3/oauth/token',
    `grant_type=authorization_code&code=${code}`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': '1.0',
        'Authorization': `Basic ${getBasicAuth()}`
      }
    }
  );

  const tokens = {
    access_token: response.data.access_token,
    refresh_token: response.data.refresh_token,
    expires_in: response.data.expires_in,
    token_type: response.data.token_type,
    scope: response.data.scope,
    obtained_at: Date.now()
  };

  saveTokens(tokens);
  return tokens;
}

async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error('Nenhum refresh_token disponivel. Faca login novamente.');
  }

  const response = await axios.post('https://api.bling.com.br/Api/v3/oauth/token',
    `grant_type=refresh_token&refresh_token=${tokens.refresh_token}`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': '1.0',
        'Authorization': `Basic ${getBasicAuth()}`
      }
    }
  );

  const newTokens = {
    access_token: response.data.access_token,
    refresh_token: response.data.refresh_token,
    expires_in: response.data.expires_in,
    token_type: response.data.token_type,
    scope: response.data.scope,
    obtained_at: Date.now()
  };

  saveTokens(newTokens);
  return newTokens;
}

async function getValidAccessToken() {
  let tokens = loadTokens();
  if (!tokens) {
    throw new Error('Nao autenticado. Acesse /auth/bling para fazer login.');
  }

  const elapsed = (Date.now() - tokens.obtained_at) / 1000;
  // Refresh 5 min antes de expirar
  if (elapsed >= (tokens.expires_in - 300)) {
    tokens = await refreshAccessToken();
  }

  return tokens.access_token;
}

function saveTokens(tokens) {
  const dir = path.dirname(TOKENS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) return null;
  return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
}

function isAuthenticated() {
  const tokens = loadTokens();
  return tokens && tokens.access_token ? true : false;
}

module.exports = {
  getAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getValidAccessToken,
  isAuthenticated,
  loadTokens
};
