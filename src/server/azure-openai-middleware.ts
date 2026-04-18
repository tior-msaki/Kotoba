/**
 * Azure OpenAI–compatible chat proxy (e.g. UCI ZotGPT).
 *
 * Same browser contract as nvidia-middleware:
 *   POST /api/azure/chat   body: { prompt, responseSchema, model?, maxCompletionTokens? }
 *
 * Upstream URL pattern:
 *   {AZURE_OPENAI_ENDPOINT}/deployments/{deployment}/chat/completions?api-version=...
 *
 * Auth: standard Azure OpenAI `api-key` header (override via
 * AZURE_OPENAI_AUTH_HEADER if your gateway expects Bearer).
 */

import type { Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildStructuredUserContent } from "./openai-proxy-shared";

interface AzureChatRequest {
  prompt?: unknown;
  responseSchema?: unknown;
  model?: unknown;
  maxCompletionTokens?: unknown;
}

interface StructuredError {
  error: string;
  code: string;
}

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

function pickMaxTokens(payload: AzureChatRequest): number | undefined {
  const v = payload.maxCompletionTokens;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.min(Math.floor(v), 128000);
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

function resolveUpstreamUrl(): string | null {
  const base =
    typeof process.env.AZURE_OPENAI_ENDPOINT === "string"
      ? process.env.AZURE_OPENAI_ENDPOINT.trim().replace(/\/$/, "")
      : "";
  const deployment =
    typeof process.env.AZURE_OPENAI_DEPLOYMENT === "string"
      ? process.env.AZURE_OPENAI_DEPLOYMENT.trim()
      : "";
  const apiVersion =
    typeof process.env.AZURE_OPENAI_API_VERSION === "string" &&
    process.env.AZURE_OPENAI_API_VERSION.trim().length > 0
      ? process.env.AZURE_OPENAI_API_VERSION.trim()
      : "2024-06-01";

  if (base.length === 0 || deployment.length === 0) return null;

  const q = new URLSearchParams({ "api-version": apiVersion });
  return `${base}/deployments/${encodeURIComponent(deployment)}/chat/completions?${q.toString()}`;
}

function resolveAuthHeaders(): Record<string, string> | null {
  const key =
    typeof process.env.AZURE_OPENAI_API_KEY === "string"
      ? process.env.AZURE_OPENAI_API_KEY.trim()
      : "";
  if (key.length === 0) return null;

  const mode =
    typeof process.env.AZURE_OPENAI_AUTH_MODE === "string"
      ? process.env.AZURE_OPENAI_AUTH_MODE.trim().toLowerCase()
      : "api-key";

  if (mode === "bearer") {
    return { Authorization: `Bearer ${key}` };
  }
  return { "api-key": key };
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== "POST") {
    return sendError(
      res,
      405,
      "Only POST is allowed on /api/azure/chat",
      "METHOD_NOT_ALLOWED"
    );
  }

  const upstreamUrl = resolveUpstreamUrl();
  const authHeaders = resolveAuthHeaders();

  if (!upstreamUrl || !authHeaders) {
    return sendError(
      res,
      500,
      "Azure OpenAI is not configured. Set AZURE_OPENAI_ENDPOINT " +
        "(e.g. https://azureapi.zotgpt.uci.edu/openai), AZURE_OPENAI_DEPLOYMENT, " +
        "and AZURE_OPENAI_API_KEY in .env, then restart Vite.",
      "MISSING_AZURE_CONFIG"
    );
  }

  let payload: AzureChatRequest;
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
    payload = JSON.parse(raw) as AzureChatRequest;
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

  const maxTokens = pickMaxTokens(payload);

  // Deployment selects the model; optional body.model ignored for Azure.
  const body: Record<string, unknown> = {
    messages: [
      {
        role: "user" as const,
        content: buildStructuredUserContent(prompt, payload.responseSchema),
      },
    ],
    response_format: { type: "json_object" as const },
    temperature: 0.2,
  };
  if (maxTokens !== undefined) {
    body.max_tokens = maxTokens;
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...authHeaders,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return sendError(
      res,
      502,
      `Could not reach Azure OpenAI: ${msg}`,
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
      `Azure OpenAI error ${upstream.status}: ${trimmed}`,
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
      "Azure OpenAI returned a non-JSON response",
      "UPSTREAM_INVALID_JSON"
    );
  }

  sendJson(res, 200, envelope);
}

export function azureOpenAiProxyMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!req.url) return next();
    if (!req.url.startsWith("/api/azure/")) return next();
    const path = req.url.split("?")[0] ?? "";
    if (path === "/api/azure/chat") {
      void handleChat(req, res);
      return;
    }
    sendError(res, 404, `Unknown Azure endpoint: ${path}`, "UNKNOWN_ENDPOINT");
  };
}
