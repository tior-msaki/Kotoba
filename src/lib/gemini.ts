/**
 * Gemini API client wrapper.
 *
 * Handles the raw HTTP call to Gemini's structured output endpoint.
 * The rest of the app never touches this — only analysis/service.ts calls it.
 */

import { AnalysisError } from "./errors";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config = {
  apiKey: null as string | null,
  model: "gemini-2.0-flash",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
};

export function setGeminiApiKey(key: string): void {
  config.apiKey = key;
}

export function setGeminiModel(model: string): void {
  config.model = model;
}

function requireApiKey(): string {
  if (!config.apiKey) {
    throw new AnalysisError(
      "Gemini API key not set. Call setGeminiApiKey() first."
    );
  }
  return config.apiKey;
}

// ---------------------------------------------------------------------------
// Structured output call
// ---------------------------------------------------------------------------

interface GeminiStructuredRequest {
  prompt: string;
  /** JSON schema object passed as response_schema for structured output. */
  responseSchema: Record<string, unknown>;
}

/**
 * Calls Gemini with structured output mode and returns the parsed JSON.
 * Throws AnalysisError on API failure or invalid response.
 */
export async function callGeminiStructured<T>(
  req: GeminiStructuredRequest
): Promise<T> {
  const apiKey = requireApiKey();
  const url = `${config.baseUrl}/models/${config.model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [{ text: req.prompt }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: req.responseSchema,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "unknown error");
    throw new AnalysisError(
      `Gemini API error ${res.status}: ${errorText}`
    );
  }

  const envelope = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = envelope.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new AnalysisError(
      "Gemini returned an empty or malformed response"
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AnalysisError(
      `Failed to parse Gemini response as JSON: ${text.slice(0, 200)}`
    );
  }
}
