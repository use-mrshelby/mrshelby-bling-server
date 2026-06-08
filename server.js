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
const RAILWAY_TOKEN = process.env.RAILWAY_API_TOKEN || '';
const RAILWAY_SVC   = process.env.RAILWAY_SERVICE_ID || '';
const RAILWAY_ENV   = process.env.RAILWAY_ENVIRONMENT_ID || '';

// ─── STATE DO TOKEN ───────────────────────────────────────────────────
let tokenState = {
  accessToken:  process.env.BLING_ACCESS_TOKEN  || null,
  refreshToken: process.env.BLING_REFRESH_TOKEN || null,
  expiresAt:    process.env.BLING_TOKEN_EXPIRES ? parseInt(process.env.BLING_TOKEN_EXPIRES) : 0
};

console.log('[Init] Token salvo:', tokenState.accessToken ? 'SIM' : 'NÃO');

// ─── HELPERS ──────────────────────────────────────────────────────────
function basicAuth() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

// Salva tokens como variáveis de ambiente no Railway via API
async function salvarTokensRailway(accessToken, refreshToken, expiresAt) {
  tokenState.accessToken  = accessToken;
  tokenState.refreshToken = refreshToken;
  tokenState.expiresAt    = expiresAt;

  if (!RAILWAY_TOKEN || !RAILWAY_SVC || !RAILWAY_ENV) {
    console.log('[Token] Railway API não configurada — tokens salvos apenas em memória');
    return;
  }

  try {
    const mutation = `
      mutation {
        variableCollectionUpsert(input: {
          serviceId: "${RAILWAY_SVC}"
          environmentId: "${RAILWAY_ENV}"
          variables: {
            BLING_ACCESS_TOKEN: "${accessToken}"
            BLING_REFRESH_TOKEN: "${refreshToken}"
            BLING_TOKEN_EXPIRES: "${expiresAt}"
          }
        })
      }
    `;
    await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RAILWAY_TOKEN}`
      },
      body: JSON.stringify({ query: mutation })
    });
    console.log('[Token] Tokens salvos no Railway com sucesso');
  } catch(e) {
    console.error('[Token] Erro ao salvar no Railway:', e.message);
  }
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
  
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  await salvarTokensRailway(data.access_token, data.refresh_token, expiresAt);
  console.log('[Token] Renovado! Expira:', new Date(expiresAt).toISOString());
  return data.access_token;
}

async function getValidToken() {
  if (!tokenState.accessToken) throw new Error('Não autenticado. Use /auth/code para autenticar.');
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

    const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    await salvarTokensRailway(data.access_token, data.refresh_token, expiresAt);
    console.log('[Auth] Autenticado com sucesso!');
    res.json({ success: true, expires_at: new Date(expiresAt).toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/auth/status', (req, res) => {
  res.json({
    connected: !!tokenState.accessToken,
    expires_at: tokenState.expiresAt ? new Date(tokenState.expiresAt).toISOString() : null,
    token_valid: !!(tokenState.accessToken && Date.now() < tokenState.expiresAt)
  });
});

app.get('/auth/url', (req, res) => {
  res.json({
    url: `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&state=mrshelby`
  });
});

// ─── ROTAS DE DADOS ───────────────────────────────────────────────────
app.get('/produtos', async (req, res) => {
  try {
    const { limite=100, pagina=1, situacao='A', nome='' } = req.query;
    let endpoint = `produtos?limite=${limite}&pagina=${pagina}&situacao=${situacao}`;
    if (nome) endpoint += `&nome=${encodeURIComponent(nome)}`;
    res.json(await blingGet(endpoint));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/pedidos', async (req, res) => {
  try {
    const { limite=50, pagina=1, situacao='', dataInicial='', dataFinal='' } = req.query;
    let endpoint = `pedidos/vendas?limite=${limite}&pagina=${pagina}`;
    if (situacao)    endpoint += `&situacoes[]=${situacao}`;
    if (dataInicial) endpoint += `&dataInicial=${dataInicial}`;
    if (dataFinal)   endpoint += `&dataFinal=${dataFinal}`;
    res.json(await blingGet(endpoint));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/estoque', async (req, res) => {
  try {
    const { limite=100, pagina=1 } = req.query;
    res.json(await blingGet(`estoques?limite=${limite}&pagina=${pagina}`));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/financeiro/receber', async (req, res) => {
  try {
    const { limite=50, situacao='' } = req.query;
    let endpoint = `contas/receber?limite=${limite}`;
    if (situacao) endpoint += `&situacoes[]=${situacao}`;
    res.json(await blingGet(endpoint));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/financeiro/pagar', async (req, res) => {
  try {
    const { limite=50 } = req.query;
    res.json(await blingGet(`contas/pagar?limite=${limite}`));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/nfe', async (req, res) => {
  try {
    const { limite=50 } = req.query;
    res.json(await blingGet(`nfe?limite=${limite}`));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

app.post('/pedidos/compra', async (req, res) => {
  try {
    const token = await getValidToken();
    const resp = await fetch(`${BLING_BASE}/pedidos/compras`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    res.json(await resp.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── ROTA CHAT IA ─────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { pergunta, dados, historico = [] } = req.body;
  if (!pergunta) return res.status(400).json({ error: 'pergunta obrigatória' });

  try {
    const sistema = `Você é o assistente de gestão da MR. Shelby, empresa brasileira de e-commerce especializada em bonés e acessórios.
Você tem acesso aos dados em tempo real do Bling ERP da empresa.

DADOS ATUAIS DO BLING:
${JSON.stringify(dados, null, 2)}

INSTRUÇÕES:
- Responda em português brasileiro, de forma objetiva e direta
- Use os dados reais fornecidos para responder
- Quando mostrar listas de produtos/pedidos, use formato de tabela markdown
- Identifique alertas importantes (estoque crítico, pedidos atrasados, vencimentos)
- Quando sugerido reposição de estoque, calcule quantidades baseado no histórico
- Para pedidos de compra, formate claramente com produto, quantidade e justificativa
- Seja proativo: além de responder, aponte oportunidades ou riscos
- Valores monetários em R$ formato brasileiro`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: sistema,
        messages: [...historico, { role: 'user', content: pergunta }]
      })
    });

    const d = await r.json();
    res.json({ resposta: d.content?.[0]?.text || 'Não foi possível obter resposta.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    app: 'MR. Shelby × Bling API',
    connected: !!tokenState.accessToken,
    token_valid: !!(tokenState.accessToken && Date.now() < tokenState.expiresAt),
    uptime: Math.floor(process.uptime()) + 's'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] MR. Shelby × Bling rodando na porta ${PORT}`));
