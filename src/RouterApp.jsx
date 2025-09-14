// RouterApp.jsx
// at top of RouterApp.jsx
import React, { Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import KnowledgeBotApp from "./App";
import ToplinesApp from "./ToplinesApp";
import Login from "./Login";

const AUTH_KEY = "av_authed_v1";

// 🔹 Floating logout button
function LogoutButton({ onLogout }) {
  return createPortal(
    <button
      onClick={onLogout}
      className="btn btn-secondary"
      style={{
        position: "fixed",
        top: "calc(env(safe-area-inset-top, 0px) + 12px)",
        /* push away from the scrollbar */
        right: "calc(env(safe-area-inset-right, 0px) + 24px)",
        left: "auto",
        zIndex: 2147483647,
        padding: "6px 12px",
        fontSize: "0.95rem",
        borderRadius: 8,
      }}
      aria-label="Log out"
      title="Log out"
    >
      Log out
    </button>,
    document.body
  );
}



export default function RouterApp() {
  const [authed, setAuthed] = useState(() => {
    try {
      return localStorage.getItem(AUTH_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      if (authed) localStorage.setItem(AUTH_KEY, "1");
      else localStorage.removeItem(AUTH_KEY);
    } catch {}
  }, [authed]);

  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />;
  }

  return (
    <BrowserRouter>
      {/* Floating logout button only */}
      <LogoutButton onLogout={() => setAuthed(false)} />

      <Suspense fallback={<div style={{ padding: 16 }}>Loading…</div>}>
        <Routes>
          {/* Default to Verbatims app */}
          <Route path="/" element={<Navigate to="/bot" replace />} />
          <Route path="/bot" element={<KnowledgeBotApp />} />
          <Route path="/toplines" element={<ToplinesApp />} />
          <Route path="*" element={<div style={{ padding: 16 }}>Not found.</div>} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
