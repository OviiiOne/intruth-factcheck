const express = require('express');
const app = express();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GLADIA_KEY = process.env.GLADIA_API_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PORT = process.env.PORT || 3000;

if (!ANTHROPIC_KEY && !GEMINI_KEY) {
  console.error('At least one of ANTHROPIC_API_KEY or GEMINI_API_KEY is required');
  process.exit(1);
}

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Gemini: convert Claude-style messages to Gemini format
function toGeminiRequest(system, messages, temperature, maxTokens) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  return {
    system_instruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    generationConfig: {
      temperature: temperature ?? 0,
      maxOutputTokens: Math.min(maxTokens || 768, 2048),
    },
  };
}

// Gemini: convert response to Claude-compatible format
function fromGeminiResponse(data) {
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return {
    content: [{ type: 'text', text }],
    model: 'gemini-2.0-flash',
    stop_reason: 'end_turn',
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
  const { max_tokens, temperature, system, messages } = body;
  const geminiModel = 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${GEMINI_KEY}`;
  const geminiBody = toGeminiRequest(system, messages, temperature, max_tokens);

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

app.post('/', async (req, res) => {
  const { messages, provider } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: { message: 'Missing or invalid messages array' } });
  }

  try {
    let result;
    const useGemini = provider === 'gemini' || (!ANTHROPIC_KEY && GEMINI_KEY);
    const useClaude = provider === 'claude' || (!GEMINI_KEY && ANTHROPIC_KEY);

    if (useGemini && GEMINI_KEY) {
      result = await handleGemini(req.body);
    } else if (useClaude && ANTHROPIC_KEY) {
      result = await handleClaude(req.body);
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
  if (ANTHROPIC_KEY) providers.push('claude');
  if (GEMINI_KEY) providers.push('gemini');
  res.json({ status: 'ok', providers, gladia: !!GLADIA_KEY });
});

app.listen(PORT, () => {
  console.log(`InTruth proxy running on port ${PORT}`);
});
