const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 55000);
const MAX_BODY_BYTES = 900_000;
const DEFAULT_MAX_COMPLETION_TOKENS = Number(process.env.DEFAULT_MAX_COMPLETION_TOKENS || 600);

const ALLOWED_MODELS = new Set(['gpt-5-mini', 'gpt-5', 'gpt-5.2', 'gpt-4o-mini']);

app.use((req, res, next) => {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).send('');
  return next();
});

app.use(express.json({ limit: MAX_BODY_BYTES }));

app.post('/api/openai-chat', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: "Expected JSON with a 'messages' array (chat/completions format).",
    });
  }

  const requestedModel = typeof body.model === 'string' ? body.model : '';
  const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : 'gpt-5-mini';
  body.model = model;

  const isGpt5 = typeof body.model === 'string' && body.model.startsWith('gpt-5');
  if (isGpt5) {
    delete body.max_tokens;
    if (body.max_completion_tokens == null) body.max_completion_tokens = DEFAULT_MAX_COMPLETION_TOKENS;
  } else {
    delete body.max_completion_tokens;
    if (body.max_tokens == null) body.max_tokens = DEFAULT_MAX_COMPLETION_TOKENS;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await upstream.text();
    return res.status(upstream.status).send(text);
  } catch (err) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({
        error: 'Upstream timeout',
        message: `OpenAI did not respond within ${UPSTREAM_TIMEOUT_MS}ms.`,
      });
    }

    return res.status(502).json({
      error: 'Upstream request failed',
      message: err?.message || String(err),
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Payload too large',
      message: `Request body exceeds ${MAX_BODY_BYTES} bytes.`,
    });
  }
  if (err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  return next(err);
});

app.get('/health', (req, res) => res.status(200).json({ ok: true }));

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`OpenAI proxy listening on port ${port}`);
});
