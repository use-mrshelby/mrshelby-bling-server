const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

// ─── CREDENCIAIS ──────────────────────────────────────────────────────
const CLIENT_ID     = process.env.BLING_CLIENT_ID     || '473a4ea3d2c9856929dc5e1f9b8f2e348b665d8e';
const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || 'e36c7cdc08cc4e3ac292593c4d6cb23940314b74dfe59beadd335ef9a482';
const BLING_BASE    = 'https://api.bling.com.br/Api/v3';
const TOKEN_URL     = 'https://www.bling.com.br/Api/v3/oauth/token';

// ─── STATE DO TOKEN ───────────────────────────────────────────────────
let tokenState = {
  accessToken:  process.env.BLING_ACCESS_TOKEN  || null,
  refreshToken: process.env.BLING_REFRESH_TOKEN || null,
  expiresAt:    0
};

// ─── HELPERS ──────────────────────────────────────────────────────────
function basicAuth() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

async function refreshToken() {
  if (!tokenState.refreshToken) throw new Error('Sem refresh token. Faça a autorização inicial.');
  console.log('[Token] Renovando access token...');
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': basicAuth()
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenState.refreshToken
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Falha ao renovar: ' + JSON.stringify(data));
  tokenState.accessToken  = data.access_token;
  tokenState.refreshToken = data.refresh_token;
  tokenState.expiresAt    = Date.now() + (data.expires_in || 3600) * 1000;
  console.log('[Token] Renovado com sucesso. Expira em:', new Date(tokenState.expiresAt).toISOString());
  return tokenState.accessToken;
}

async function getValidToken() {
  if (!tokenState.accessToken) throw new Error('Não autenticado. Use /auth/code para autenticar.');
  // Renova se faltar menos de 5 minutos
  if (Date.now() > tokenState.expiresAt - 300000) {
    await refreshToken();
  }
  return tokenState.accessToken;
}

async function blingGet(endpoint) {
  const token = await getValidToken();
  const resp = await fetch(`${BLING_BASE}/${endpoint}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (resp.status === 401) {
    await refreshToken();
    return blingGet(endpoint);
  }
  const text = await resp.text();
  try { return JSON.parse(text); } catch(e) { return { error: text }; }
}

// ─── RENOVAÇÃO AUTOMÁTICA A CADA 50 MINUTOS ───────────────────────────
setInterval(async () => {
  if (tokenState.refreshToken) {
    try { await refreshToken(); }
    catch(e) { console.error('[Auto-refresh] Erro:', e.message); }
  }
}, 50 * 60 * 1000);

// ─── ROTAS DE AUTH ────────────────────────────────────────────────────

// Troca o code pelo access + refresh token
app.post('/auth/code', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code obrigatório' });
  try {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': basicAuth()
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code })
    });
    const data = await resp.json();
    if (!data.access_token) return res.status(400).json({ error: 'Falha na autenticação', detail: data });
    tokenState.accessToken  = data.access_token;
    tokenState.refreshToken = data.refresh_token;
    tokenState.expiresAt    = Date.now() + (data.expires_in || 3600) * 1000;
    console.log('[Auth] Autenticado com sucesso!');
    res.json({ success: true, expires_at: new Date(tokenState.expiresAt).toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Status da conexão
app.get('/auth/status', (req, res) => {
  res.json({
    connected: !!tokenState.accessToken,
    expires_at: tokenState.expiresAt ? new Date(tokenState.expiresAt).toISOString() : null,
    token_valid: tokenState.accessToken && Date.now() < tokenState.expiresAt
  });
});

// URL de autorização do Bling
app.get('/auth/url', (req, res) => {
  const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&state=mrshelby`;
  res.json({ url });
});

// ─── ROTAS DE DADOS ───────────────────────────────────────────────────

app.get('/produtos', async (req, res) => {
  try {
    const { limite = 100, pagina = 1, situacao = 'A', nome = '' } = req.query;
    let endpoint = `produtos?limite=${limite}&pagina=${pagina}&situacao=${situacao}`;
    if (nome) endpoint += `&nome=${encodeURIComponent(nome)}`;
    const data = await blingGet(endpoint);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/pedidos', async (req, res) => {
  try {
    const { limite = 50, pagina = 1, situacao = '', dataInicial = '', dataFinal = '' } = req.query;
    let endpoint = `pedidos/vendas?limite=${limite}&pagina=${pagina}`;
    if (situacao)    endpoint += `&situacoes[]=${situacao}`;
    if (dataInicial) endpoint += `&dataInicial=${dataInicial}`;
    if (dataFinal)   endpoint += `&dataFinal=${dataFinal}`;
    const data = await blingGet(endpoint);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/estoque', async (req, res) => {
  try {
    const { limite = 100, pagina = 1 } = req.query;
    const data = await blingGet(`estoques?limite=${limite}&pagina=${pagina}`);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/financeiro/receber', async (req, res) => {
  try {
    const { limite = 50, situacao = '' } = req.query;
    let endpoint = `contas/receber?limite=${limite}`;
    if (situacao) endpoint += `&situacoes[]=${situacao}`;
    const data = await blingGet(endpoint);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/financeiro/pagar', async (req, res) => {
  try {
    const { limite = 50 } = req.query;
    const data = await blingGet(`contas/pagar?limite=${limite}`);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/nfe', async (req, res) => {
  try {
    const { limite = 50 } = req.query;
    const data = await blingGet(`nfe?limite=${limite}`);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Endpoint agregado — busca tudo de uma vez para o dashboard
app.get('/dashboard', async (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const [produtos, pedidos, estoque] = await Promise.all([
      blingGet('produtos?limite=100&situacao=A'),
      blingGet(`pedidos/vendas?limite=50&dataInicial=${hoje}&dataFinal=${hoje}`),
      blingGet('estoques?limite=100')
    ]);
    const estoqueItems = estoque.data || [];
    const criticos = estoqueItems.filter(e => (e.saldoVirtualTotal || 0) <= (e.estoqueMinimo || 3));
    res.json({
      produtos_ativos: (produtos.data || []).length,
      pedidos_hoje: (pedidos.data || []).length,
      faturamento_hoje: (pedidos.data || []).reduce((s, p) => s + parseFloat(p.totalVenda || 0), 0),
      estoque_critico: criticos.length,
      criticos: criticos.slice(0, 10),
      pedidos_recentes: (pedidos.data || []).slice(0, 8)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Endpoint para criar pedido de compra
app.post('/pedidos/compra', async (req, res) => {
  try {
    const token = await getValidToken();
    const resp = await fetch(`${BLING_BASE}/pedidos/compras`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });
    const data = await resp.json();
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    app: 'MR. Shelby × Bling API',
    connected: !!tokenState.accessToken,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] MR. Shelby × Bling rodando na porta ${PORT}`));
