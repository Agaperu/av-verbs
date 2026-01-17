// netlify/functions/openai-chat.js

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

// Keep this below Netlify's 30s hard kill.
// Netlify local dev shows 30.00s; production can vary, but 25s is a safe ceiling.
const UPSTREAM_TIMEOUT_MS = 25000;

// Guardrail: prevent very large payloads from blowing up runtime.
// (Tune as needed; 900kB is already very large for JSON.)
const MAX_BODY_BYTES = 900_000;

// Optional: whitelist / fallback models to avoid unexpected slow/invalid values.
// You can adjust this list to whatever you actually use.
const ALLOWED_MODELS = new Set(["gpt-5-mini", "gpt-5", "gpt-5.2", "gpt-4o-mini"]);

exports.handler = async (event) => {
  try {
    // CORS preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    // Basic payload size guard
    const rawBody = event.body || "";
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return {
        statusCode: 413,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "Payload too large",
          message: `Request body exceeds ${MAX_BODY_BYTES} bytes. Reduce MAX_INPUT_CHARS or chunk size.`,
        }),
      };
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }),
      };
    }

    let body;
    try {
      body = JSON.parse(rawBody || "{}");
    } catch {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Invalid JSON body" }),
      };
    }

    // Safety: ensure body shape is what chat/completions expects
    // (Your frontend sends { model, messages }, so this should be fine.)
    if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "Bad Request",
          message: "Expected JSON with a 'messages' array (chat/completions format).",
        }),
      };
    }

    // Model fallback to avoid accidental slow/invalid values causing long waits
    const requestedModel = typeof body.model === "string" ? body.model : "";
    const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : "gpt-5-mini";
    body.model = model;

    // Token limit compatibility:
    // - GPT-5.x requires max_completion_tokens
    // - Older models require max_tokens
    const isGpt5 = typeof body.model === "string" && body.model.startsWith("gpt-5");

    if (isGpt5) {
      // Do NOT send max_tokens to GPT-5 models
      delete body.max_tokens;
      if (body.max_completion_tokens == null) {
        body.max_completion_tokens = 600;
      }
    } else {
      // Do NOT send max_completion_tokens to older models
      delete body.max_completion_tokens;
      if (body.max_tokens == null) {
        body.max_tokens = 600;
      }
    }


    // Timeout the upstream call so Netlify doesn't hard-kill us first
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    let upstream;
    let text;

    try {
      upstream = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      text = await upstream.text();
    } catch (err) {
      // AbortController timeout → return a clean error instead of a Netlify 30s kill
      if (err?.name === "AbortError") {
        return {
          statusCode: 504,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            error: "Upstream timeout",
            message: `OpenAI did not respond within ${UPSTREAM_TIMEOUT_MS}ms. Reduce MAX_INPUT_CHARS, use a faster model (gpt-5-mini), and/or lower max_tokens.`,
          }),
        };
      }

      return {
        statusCode: 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "Upstream request failed",
          message: err?.message || String(err),
        }),
      };
    } finally {
      clearTimeout(timeout);
    }

    // Forward upstream response through to the browser
    return {
      statusCode: upstream.status,
      headers: CORS_HEADERS,
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Function crashed",
        message: err?.message || String(err),
      }),
    };
  }
};
