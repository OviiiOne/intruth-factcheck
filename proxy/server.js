const express = require('express');
const app = express();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GLADIA_KEY = process.env.GLADIA_API_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
const PORT = process.env.PORT || 3000;

if (!ANTHROPIC_KEY && !GEMINI_KEY && !GROQ_KEY) {
  console.error('At least one of ANTHROPIC_API_KEY, GEMINI_API_KEY or GROQ_API_KEY is required');
  process.exit(1);
}

if (!PROXY_TOKEN) {
  console.warn('WARNING: PROXY_TOKEN not set — the proxy is OPEN to anyone with the URL. Set PROXY_TOKEN to require a secret.');
}

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-proxy-token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Shared-secret gate: a public URL alone can't use the proxy without the token.
// (CORS does not stop direct calls — this does.) /health stays open for checks.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (PROXY_TOKEN && req.get('x-proxy-token') !== PROXY_TOKEN) {
    return res.status(401).json({ error: { message: 'Unauthorized — missing or invalid proxy token' } });
  }
  next();
});

// Gemini: convert Claude-style messages to Gemini format
function toGeminiRequest(system, messages, temperature, maxTokens, grounded) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const req = {
    system_instruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    generationConfig: {
      temperature: temperature ?? 0,
      maxOutputTokens: Math.min(maxTokens || 768, 2048),
    },
  };
  // Let Gemini search Google itself and ground the answer in real results.
  if (grounded) req.tools = [{ google_search: {} }];
  return req;
}

// Gemini: convert response to Claude-compatible format (+ grounding sources)
function fromGeminiResponse(data) {
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('') || '';
  const chunks = cand?.groundingMetadata?.groundingChunks || [];
  const sources = chunks.map(c => c.web?.uri).filter(Boolean);
  return {
    content: [{ type: 'text', text }],
    model: 'gemini-2.0-flash',
    stop_reason: 'end_turn',
    sources,
  };
}

async function handleClaude(body) {
  const { model, max_tokens, temperature, system, messages } = body;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: Math.min(max_tokens || 768, 2048),
      temperature: temperature ?? 0,
      system: system || '',
      messages,
    }),
  });
  return { status: response.status, data: await response.json() };
}

async function handleGemini(body) {
  const { max_tokens, temperature, system, messages, grounded } = body;
  const geminiModel = 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${GEMINI_KEY}`;
  const geminiBody = toGeminiRequest(system, messages, temperature, max_tokens, grounded);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiBody),
  });

  const raw = await response.json();
  if (!response.ok) {
    return { status: response.status, data: { error: { message: raw.error?.message || 'Gemini API error' } } };
  }
  return { status: 200, data: fromGeminiResponse(raw) };
}

async function handleGroq(body) {
  const { max_tokens, temperature, system, messages, grounded, json } = body;
  // 'compound-beta' has built-in web search (free tier); use it only when grounding
  // is requested (verification). Otherwise a fast normal model for the frequent calls.
  const model = grounded ? 'compound-beta' : 'llama-3.3-70b-versatile';

  const groqMessages = [];
  if (system) groqMessages.push({ role: 'system', content: system });
  for (const m of messages) {
    groqMessages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }

  const groqBody = {
    model,
    messages: groqMessages,
    temperature: temperature ?? 0,
    max_tokens: Math.min(max_tokens || 768, 4096),
  };
  // Force valid JSON for structured calls (key points). Not with compound (search).
  if (json && !grounded) groqBody.response_format = { type: 'json_object' };

  const callGroq = (b) => fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
    body: JSON.stringify(b),
  });

  let response = await callGroq(groqBody);
  let raw = await response.json();
  // JSON mode can fail ("Failed to generate JSON"); retry once as plain text — the
  // prompt still asks for JSON and the client parses leniently.
  if (!response.ok && groqBody.response_format) {
    delete groqBody.response_format;
    response = await callGroq(groqBody);
    raw = await response.json();
  }
  if (!response.ok) {
    return { status: response.status, data: { error: { message: raw.error?.message || 'Groq API error' } } };
  }

  const msg = raw.choices?.[0]?.message || {};
  const text = msg.content || '';
  // compound models report what they searched; pull source URLs when present.
  const sources = [];
  for (const t of (msg.executed_tools || [])) {
    const results = t?.search_results?.results || t?.results || [];
    for (const r of results) { if (r && r.url) sources.push(r.url); }
  }
  return { status: 200, data: { content: [{ type: 'text', text }], model, stop_reason: 'end_turn', sources } };
}

app.post('/', async (req, res) => {
  const { messages, provider } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: { message: 'Missing or invalid messages array' } });
  }

  try {
    let result;
    if (provider === 'groq' && GROQ_KEY) {
      result = await handleGroq(req.body);
    } else if (provider === 'gemini' && GEMINI_KEY) {
      result = await handleGemini(req.body);
    } else if (provider === 'claude' && ANTHROPIC_KEY) {
      result = await handleClaude(req.body);
    } else if (GROQ_KEY) {
      result = await handleGroq(req.body);
    } else if (GEMINI_KEY) {
      result = await handleGemini(req.body);
    } else {
      result = await handleClaude(req.body);
    }

    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: { message: 'Proxy failed to reach API' } });
  }
});

// Gladia: start a live session server-side so the Gladia key never reaches the
// browser. The client sends the session config; we add the key and forward.
// Gladia returns a pre-authorized WebSocket URL the browser connects to directly.
app.post('/gladia/live', async (req, res) => {
  if (!GLADIA_KEY) {
    return res.status(400).json({ error: { message: 'GLADIA_API_KEY not configured on the proxy' } });
  }
  try {
    const response = await fetch('https://api.gladia.io/v2/live', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gladia-key': GLADIA_KEY,
      },
      body: JSON.stringify(req.body || {}),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Gladia proxy error:', err.message);
    res.status(502).json({ error: { message: 'Proxy failed to reach Gladia' } });
  }
});

app.get('/health', (req, res) => {
  const providers = [];
  if (GROQ_KEY) providers.push('groq');
  if (ANTHROPIC_KEY) providers.push('claude');
  if (GEMINI_KEY) providers.push('gemini');
  res.json({ status: 'ok', providers, gladia: !!GLADIA_KEY });
});

app.listen(PORT, () => {
  console.log(`InTruth proxy running on port ${PORT}`);
});
