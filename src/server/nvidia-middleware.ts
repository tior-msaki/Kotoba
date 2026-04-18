/**
 * NVIDIA API proxy middleware for the Vite dev / preview server.
 *
 * WHY THIS EXISTS
 * ---------------
 * NVIDIA's `https://integrate.api.nvidia.com` endpoint does not set
 * permissive CORS headers, so the browser cannot call it directly — every
 * fetch from client JS fails with the generic "Failed to fetch" TypeError
 * before any response is received. In addition, calling NVIDIA from the
 * browser would require the API key to be bundled into client JS, which is
 * a leak.
 *
 * This middleware gives the browser a same-origin endpoint to hit:
 *
 *   POST /api/nvidia/chat    body: { prompt, responseSchema, model? }
 *
 * The server reads `NVIDIA_API_KEY` (and optional `NVIDIA_MODEL`) from
 * `process.env`, builds the OpenAI-compatible chat-completions body (the
 * schema is embedded into the user message and `response_format:
 * {type:"json_object"}` forces JSON-only output), forwards to NVIDIA with
 * Bearer auth, and returns the raw OpenAI envelope on success. Every
 * failure path returns a structured `{ error, code }` JSON body with the
 * matching HTTP status, so the client can surface actionable messages
 * instead of a bare "Failed to fetch".
 *
 * INTEGRATION
 * -----------
 * `vite.config.ts` wires this as a `configureServer` + `configurePreview`
 * plugin hook. The middleware is only active while `vite dev` or `vite
 * preview` is running. A production deployment without a Node server
 * would need an equivalent endpoint hosted elsewhere (same contract).
 */

import type { Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

const NVIDIA_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_MODEL = "meta/llama-3.1-70b-instruct";

interface NvidiaChatRequest {
  prompt?: unknown;
  responseSchema?: unknown;
  model?: unknown;
}

interface StructuredError {
  error: string;
  code: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  code: string
): void {
  sendJson(res, status, { error, code } satisfies StructuredError);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function buildUserContent(prompt: string, schema: unknown): string {
  return (
    `${prompt}\n\n` +
    `Respond with a single JSON object matching this JSON Schema exactly. ` +
    `Do not include markdown fences, prose, or commentary — the entire ` +
    `response must be valid JSON.\n\n` +
    `JSON Schema:\n${JSON.stringify(schema)}`
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== "POST") {
    return sendError(
      res,
      405,
      "Only POST is allowed on /api/nvidia/chat",
      "METHOD_NOT_ALLOWED"
    );
  }

  const apiKey = process.env.NVIDIA_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return sendError(
      res,
      500,
      "NVIDIA_API_KEY is not set on the server. Add it to .env at the " +
        "repository root and restart the Vite server (npm run dev).",
      "MISSING_API_KEY"
    );
  }
  const defaultModel =
    (typeof process.env.NVIDIA_MODEL === "string" &&
      process.env.NVIDIA_MODEL.trim()) ||
    DEFAULT_MODEL;

  let payload: NvidiaChatRequest;
  try {
    const raw = await readBody(req);
    if (raw.length === 0) {
      return sendError(
        res,
        400,
        "Empty request body — expected { prompt, responseSchema }",
        "EMPTY_BODY"
      );
    }
    payload = JSON.parse(raw) as NvidiaChatRequest;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return sendError(res, 400, `Invalid JSON body: ${msg}`, "INVALID_BODY");
  }

  const prompt =
    typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (prompt.length === 0) {
    return sendError(
      res,
      400,
      "Missing or empty `prompt` field",
      "INVALID_PROMPT"
    );
  }
  if (
    !payload.responseSchema ||
    typeof payload.responseSchema !== "object" ||
    Array.isArray(payload.responseSchema)
  ) {
    return sendError(
      res,
      400,
      "Missing or invalid `responseSchema` field — must be a JSON schema object",
      "INVALID_SCHEMA"
    );
  }

  const model =
    typeof payload.model === "string" && payload.model.trim().length > 0
      ? payload.model.trim()
      : defaultModel;

  const body = {
    model,
    messages: [
      { role: "user", content: buildUserContent(prompt, payload.responseSchema) },
    ],
    response_format: { type: "json_object" as const },
    temperature: 0.2,
  };

  let upstream: Response;
  try {
    upstream = await fetch(NVIDIA_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return sendError(
      res,
      502,
      `Could not reach NVIDIA API: ${msg}`,
      "UPSTREAM_UNREACHABLE"
    );
  }

  if (!upstream.ok) {
    const errorText = await upstream.text().catch(() => "unknown error");
    const trimmed = errorText.slice(0, 500);
    const code =
      upstream.status === 401 || upstream.status === 403
        ? "UPSTREAM_AUTH_FAILED"
        : upstream.status === 429
          ? "UPSTREAM_RATE_LIMITED"
          : "UPSTREAM_ERROR";
    return sendError(
      res,
      upstream.status,
      `NVIDIA API error ${upstream.status}: ${trimmed}`,
      code
    );
  }

  let envelope: unknown;
  try {
    envelope = await upstream.json();
  } catch {
    return sendError(
      res,
      502,
      "NVIDIA API returned a non-JSON response",
      "UPSTREAM_INVALID_JSON"
    );
  }

  // Pass through the OpenAI-shape envelope as-is — the client reads
  // choices[0].message.content and parses it as JSON.
  sendJson(res, 200, envelope);
}

// ---------------------------------------------------------------------------
// Middleware dispatcher
// ---------------------------------------------------------------------------

export function nvidiaProxyMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!req.url) return next();
    if (!req.url.startsWith("/api/nvidia/")) return next();
    const path = req.url.split("?")[0] ?? "";
    if (path === "/api/nvidia/chat") {
      void handleChat(req, res);
      return;
    }
    sendError(res, 404, `Unknown NVIDIA endpoint: ${path}`, "UNKNOWN_ENDPOINT");
  };
}
