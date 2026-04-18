/**
 * Completion token ceilings per analysis shape.
 * Passed to LLM proxies as `max_tokens` so the model cannot stream an
 * arbitrarily long JSON blob (major source of multi-minute latency).
 */

export const LLM_MAX_LINE = 8192;
export const LLM_MAX_STANZA = 16384;
export const LLM_MAX_SONG = 32768;
export const LLM_MAX_STANZA_OVERVIEW_FROM_LINES = 8192;
export const LLM_MAX_SONG_OVERVIEW_FROM_STANZAS = 16384;
export const LLM_MAX_ASK_SELECTION = 4096;
export const LLM_MAX_WORD_DETAIL = 6144;
