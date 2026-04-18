import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { ytmusicSearchMiddleware } from "./src/server/ytmusic-middleware";
import { nvidiaProxyMiddleware } from "./src/server/nvidia-middleware";
import { azureOpenAiProxyMiddleware } from "./src/server/azure-openai-middleware";

/**
 * YouTube Music search is served by a Node-side middleware mounted here
 * because `ytmusic-api` is Node-only (axios + tough-cookie + internal
 * YouTube endpoints that set CORS headers that block direct browser
 * calls). Browser code fetches `/api/ytmusic/search?q=...` and never
 * imports `ytmusic-api` itself. Active in `vite dev` AND `vite preview`.
 * A production deployment without a Node server would need an equivalent
 * endpoint hosted elsewhere.
 */
const ytmusicProxyPlugin = () => ({
  name: "kotoba-ytmusic-proxy",
  configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
    server.middlewares.use(ytmusicSearchMiddleware());
  },
  configurePreviewServer(server: { middlewares: { use: (fn: unknown) => void } }) {
    server.middlewares.use(ytmusicSearchMiddleware());
  },
});

/**
 * NVIDIA analysis is served by a same-origin proxy mounted here because
 * `integrate.api.nvidia.com` does not set permissive CORS headers —
 * direct browser fetches fail with "Failed to fetch" before any response
 * is received. The proxy also keeps the API key server-side so it is
 * never bundled into client JS. Browser code POSTs to `/api/nvidia/chat`.
 */
const nvidiaProxyPlugin = () => ({
  name: "kotoba-nvidia-proxy",
  configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
    server.middlewares.use(nvidiaProxyMiddleware());
  },
  configurePreviewServer(server: { middlewares: { use: (fn: unknown) => void } }) {
    server.middlewares.use(nvidiaProxyMiddleware());
  },
});

/**
 * Azure OpenAI (e.g. ZotGPT) — same JSON contract as NVIDIA; browser uses
 * `/api/azure/chat` when `VITE_LLM_PROVIDER=azure`.
 */
const azureOpenAiProxyPlugin = () => ({
  name: "kotoba-azure-openai-proxy",
  configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
    server.middlewares.use(azureOpenAiProxyMiddleware());
  },
  configurePreviewServer(server: { middlewares: { use: (fn: unknown) => void } }) {
    server.middlewares.use(azureOpenAiProxyMiddleware());
  },
});

export default defineConfig(({ mode }) => {
  // Vite's `envPrefix` only controls which variables get injected into
  // the client's `import.meta.env`. Server-side middleware runs in Node
  // and reads `process.env` directly — Vite does NOT auto-populate that
  // from the `.env` file. `loadEnv("", ...)` reads every var in .env
  // (no prefix filter); we copy them into `process.env` so the NVIDIA
  // middleware can see `NVIDIA_API_KEY` / `NVIDIA_MODEL`. Existing
  // `process.env` values take precedence so CI / shell exports still win.
  const fileEnv = loadEnv(mode, process.cwd(), "");
  for (const [k, v] of Object.entries(fileEnv)) {
    if (typeof v === "string" && process.env[k] === undefined) {
      process.env[k] = v;
    }
  }

  return {
    plugins: [
      react(),
      ytmusicProxyPlugin(),
      nvidiaProxyPlugin(),
      azureOpenAiProxyPlugin(),
    ],
    // NVIDIA_ is intentionally NOT in envPrefix: the key lives server-side
    // (read by nvidia-middleware.ts from process.env) and must never ship
    // in client JS. SPOTIFY_CLIENT_SECRET is the existing local-prototype
    // exception and still ships client-side — only use throwaway creds.
    envPrefix: ["VITE_", "SPOTIFY_", "YOUTUBE_"],
  };
});
