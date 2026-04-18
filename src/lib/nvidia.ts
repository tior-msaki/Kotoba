/**
 * NVIDIA analysis client (browser-side).
 *
 * Posts to the same-origin proxy at `/api/nvidia/chat` served by
 * `src/server/nvidia-middleware.ts`. The server owns the API key and
 * the upstream NVIDIA call — this client only speaks to the Node
 * middleware, which is why there is no Bearer auth here and why
 * `setNvidiaApiKey` is kept as a compatibility no-op.
 *
 * Direct browser calls to `integrate.api.nvidia.com` fail with
 * "Failed to fetch" because that origin does not send permissive CORS
 * headers — routing through our own server avoids that entirely.
 *
 * Error handling: every failure mode is translated into an
 * AnalysisError whose message distinguishes
 *   - network error / dev server not reachable
 *   - missing route (404) / stale middleware
 *   - structured backend error (missing API key, upstream auth, rate
 *     limits, upstream 5xx) — the server returns `{ error, code }` JSON
 *     and the message + code are surfaced verbatim
 *   - non-JSON response (e.g. HTML error page from a different handler)
 *   - valid envelope with empty content
 * so the UI no longer has to render the generic "Failed to fetch".
 */

import { AnalysisError } from "./errors";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CHAT_URL = "/api/nvidia/chat";

// Kept for backwards compatibility with callers that still invoke the
// setters (smoke tests, services/app.ts initFromEnv). The values are not
// used for the HTTP call — the server owns them via process.env. Storing
// the model lets callers override the server default per-request.
const config = {
  apiKey: null as string | null,
  model: null as string | null,
};

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

interface NvidiaStructuredRequest {
  prompt: string;
  /** JSON schema object describing the expected response shape. */
  responseSchema: Record<string, unknown>;
}

interface BackendError {
  error?: string;
  code?: string;
}

function formatBackendError(body: BackendError, status: number): string {
  const base =
    typeof body.error === "string" && body.error.length > 0
      ? body.error
      : `Analysis backend returned HTTP ${status}`;
  return typeof body.code === "string" && body.code.length > 0
    ? `${base} [${body.code}]`
    : base;
}

/**
 * Calls the server-side NVIDIA proxy with a prompt + response schema and
 * returns the parsed JSON payload. Throws an {@link AnalysisError} with
 * a specific, actionable message on every failure mode.
 */
export async function callNvidiaStructured<T>(
  req: NvidiaStructuredRequest
): Promise<T> {
  const requestBody: Record<string, unknown> = {
    prompt: req.prompt,
    responseSchema: req.responseSchema,
  };
  if (config.model) requestBody.model = config.model;

  let res: Response;
  try {
    res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    // `fetch` only rejects on true network-layer failures: DNS, TLS,
    // connection refused, CORS preflight blocked, user offline, etc.
    // At this point the Vite dev server is almost certainly down or the
    // browser blocked the request outright.
    const msg = err instanceof Error ? err.message : String(err);
    throw new AnalysisError(
      `Cannot reach the analysis backend at ${CHAT_URL}. The dev server ` +
        `may not be running or the browser blocked the request. (${msg})`
    );
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const isJson = contentType.includes("application/json");

  if (!res.ok) {
    if (isJson) {
      let body: BackendError = {};
      try {
        body = (await res.json()) as BackendError;
      } catch {
        /* fall through to generic message below */
      }
      throw new AnalysisError(formatBackendError(body, res.status));
    }
    if (res.status === 404) {
      throw new AnalysisError(
        `Analysis endpoint ${CHAT_URL} is not mounted. Restart the Vite ` +
          `server so the NVIDIA proxy middleware registers.`
      );
    }
    const raw = await res.text().catch(() => "");
    throw new AnalysisError(
      `Analysis backend returned HTTP ${res.status}: ` +
        (raw.slice(0, 200) || "(no body)")
    );
  }

  if (!isJson) {
    const raw = await res.text().catch(() => "");
    throw new AnalysisError(
      `Analysis backend returned a non-JSON response ` +
        `(content-type: ${contentType || "none"}): ` +
        (raw.slice(0, 200) || "(empty)")
    );
  }

  let envelope: { choices?: Array<{ message?: { content?: string } }> };
  try {
    envelope = (await res.json()) as typeof envelope;
  } catch {
    throw new AnalysisError(
      "Analysis backend returned an invalid JSON envelope."
    );
  }

  const text = envelope.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.length === 0) {
    throw new AnalysisError(
      "Analysis backend returned an empty response — the provider may be " +
        "throttling or the model produced no output."
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AnalysisError(
      `Failed to parse analysis response as JSON: ${text.slice(0, 200)}`
    );
  }
}
