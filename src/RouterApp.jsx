// RouterApp.jsx
// at top of RouterApp.jsx
import React, { Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";

import KnowledgeBotApp from "./App";
import ToplinesApp from "./ToplinesApp";
import Login from "./Login";
import Chatbot from "./Chatbot";

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



function AppsContainer() {
  const loc = useLocation();
  const showBot = loc.pathname === "/bot" || loc.pathname === "/";

  return (
    <>
      <div style={{ display: showBot ? "block" : "none" }}>
        <KnowledgeBotApp />
      </div>
      <div style={{ display: showBot ? "none" : "block" }}>
        <ToplinesApp />
      </div>
    </>
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
          <Route path="/bot" element={<AppsContainer />} />
          <Route path="/toplines" element={<AppsContainer />} />
          <Route path="/chatbot" element={<Chatbot />} />
          <Route path="*" element={<AppsContainer />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
