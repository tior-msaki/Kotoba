/**
 * Browser client for same-origin OpenAI-compatible chat proxies
 * (`/api/nvidia/chat`, `/api/azure/chat`, etc.).
 *
 * Each proxy returns the raw OpenAI envelope; we parse
 * `choices[0].message.content` as JSON.
 */

import { AnalysisError } from "./errors";

export interface StructuredProxyRequest {
  prompt: string;
  responseSchema: Record<string, unknown>;
  /**
   * Maps to OpenAI `max_tokens` on the upstream chat-completions request.
   * Omit to let the provider use its default (can be very large and slow).
   */
  maxCompletionTokens?: number;
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
 * POSTs to `chatPath` with prompt + schema. Optional `model` is sent when set
 * (NVIDIA uses it; Azure ignores it — deployment is server-side).
 */
export async function callOpenAiProxyStructured<T>(
  chatPath: string,
  req: StructuredProxyRequest,
  model: string | null
): Promise<T> {
  const requestBody: Record<string, unknown> = {
    prompt: req.prompt,
    responseSchema: req.responseSchema,
  };
  if (model) requestBody.model = model;
  if (
    typeof req.maxCompletionTokens === "number" &&
    Number.isFinite(req.maxCompletionTokens) &&
    req.maxCompletionTokens > 0
  ) {
    requestBody.maxCompletionTokens = Math.floor(req.maxCompletionTokens);
  }

  let res: Response;
  try {
    res = await fetch(chatPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AnalysisError(
      `Cannot reach the analysis backend at ${chatPath}. The dev server ` +
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
        /* fall through */
      }
      throw new AnalysisError(formatBackendError(body, res.status));
    }
    if (res.status === 404) {
      throw new AnalysisError(
        `Analysis endpoint ${chatPath} is not mounted. Restart the Vite ` +
          `server so the LLM proxy middleware registers.`
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
