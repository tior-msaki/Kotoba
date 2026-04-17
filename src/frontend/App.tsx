import { Navigate, Route, Routes } from "react-router-dom";
import { LegacyDesignFrame } from "./LegacyDesignFrame";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LegacyDesignFrame page="home" />} />
      <Route path="/diskbox" element={<LegacyDesignFrame page="diskbox" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
