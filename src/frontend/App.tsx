import { Navigate, Route, Routes } from "react-router-dom";
import { LegacyDesignFrame } from "./LegacyDesignFrame";

// The React shell intentionally owns a single route. All page-to-page
// navigation (home ↔ diskbox ↔ disk-select) happens inside the iframe via
// relative URLs, matching the static-HTML-first posture documented in
// ARCHITECTURE.md. The catch-all below keeps direct URL hits harmless.
export function App() {
  return (
    <Routes>
      <Route path="/" element={<LegacyDesignFrame />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
