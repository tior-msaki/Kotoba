/**
 * NVIDIA analysis client (browser-side).
 *
 * Posts to the same-origin proxy at `/api/nvidia/chat` served by
 * `src/server/nvidia-middleware.ts`. The server owns the API key and
 * the upstream NVIDIA call — this client only speaks to the Node
 * middleware, which is why there is no Bearer auth here and why
 * `setNvidiaApiKey` is kept as a compatibility no-op.
 *
 * Prefer {@link callLlmStructured} from `./llm` for app code so the
 * provider can be switched via `VITE_LLM_PROVIDER`.
 *
 * Direct browser calls to `integrate.api.nvidia.com` fail with
 * "Failed to fetch" because that origin does not send permissive CORS
 * headers — routing through our own server avoids that entirely.
 */

import { AnalysisError } from "./errors";
import {
  callOpenAiProxyStructured,
  type StructuredProxyRequest,
} from "./openai-proxy-client";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CHAT_URL = "/api/nvidia/chat";

const config = {
  apiKey: null as string | null,
  model: null as string | null,
};

/** Used by `llm.ts` when forwarding optional model override to the proxy. */
export function getClientLlmModelOverride(): string | null {
  return config.model;
}

/**
 * Stores an API key client-side for compatibility. The key is NOT sent
 * to NVIDIA — the server middleware reads its own NVIDIA_API_KEY from
 * process.env. Kept so legacy callers (initFromEnv, tests) don't break.
 */
export function setNvidiaApiKey(key: string): void {
  config.apiKey = key;
}

/**
 * Override the model id for subsequent calls. Pass-through to the
 * server, which falls back to `NVIDIA_MODEL` (env) or the built-in
 * default when omitted.
 */
export function setNvidiaModel(model: string): void {
  config.model = model;
}

// ---------------------------------------------------------------------------
// Structured output call
// ---------------------------------------------------------------------------

/**
 * Calls the server-side NVIDIA proxy with a prompt + response schema and
 * returns the parsed JSON payload. Throws an {@link AnalysisError} with
 * a specific, actionable message on every failure mode.
 */
export async function callNvidiaStructured<T>(
  req: StructuredProxyRequest
): Promise<T> {
  return callOpenAiProxyStructured<T>(CHAT_URL, req, config.model);
}
