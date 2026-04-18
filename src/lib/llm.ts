/**
 * Analysis LLM entry point — picks the same-origin proxy (NVIDIA vs Azure)
 * from `import.meta.env.VITE_LLM_PROVIDER`.
 *
 * Throughput: line batches already run in parallel via `maxConcurrentLlm` in
 * the analysis service. Switching provider or raising concurrency is how
 * you "go faster"; routing one song across two providers would require
 * explicit sharding logic not present here.
 */

import {
  callOpenAiProxyStructured,
  type StructuredProxyRequest,
} from "./openai-proxy-client";
import { getClientLlmModelOverride } from "./nvidia";

export type LlmProviderId = "nvidia" | "azure";

function resolveChatPath(): string {
  const raw = import.meta.env.VITE_LLM_PROVIDER as string | undefined;
  const p = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (p === "azure" || p === "zotgpt") return "/api/azure/chat";
  return "/api/nvidia/chat";
}

export function getActiveLlmProvider(): LlmProviderId {
  const raw = import.meta.env.VITE_LLM_PROVIDER as string | undefined;
  const p = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (p === "azure" || p === "zotgpt") return "azure";
  return "nvidia";
}

/**
 * Structured JSON call — same contract as {@link callNvidiaStructured};
 * the server route depends on `VITE_LLM_PROVIDER`.
 */
export async function callLlmStructured<T>(
  req: StructuredProxyRequest
): Promise<T> {
  return callOpenAiProxyStructured<T>(
    resolveChatPath(),
    req,
    getClientLlmModelOverride()
  );
}
