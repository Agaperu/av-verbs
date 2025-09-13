// RouterApp.jsx
import React, { Suspense, lazy, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";

import KnowledgeBotApp from "./App";
import ToplinesApp from "./ToplinesApp";
import Login from "./Login";

// ⬇️ Add your logo import
import avLogo from "./assets/av-logo.png";

const AUTH_KEY = "av_authed_v1";

function Nav({ onLogout }) {
  const linkStyle = ({ isActive }) => ({
    padding: "10px 14px",
    borderRadius: 10,
    fontWeight: 600,
    textDecoration: "none",
    color: isActive ? "white" : "#1a365d",
    background: isActive ? "#1a365d" : "transparent",
    border: "1px solid rgba(0,0,0,0.10)",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  });

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        marginBottom: 10,
        borderBottom: "1px solid rgba(0,0,0,0.08)",
        background: "var(--background-color, #fff)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* ⬇️ Replace title text with logo */}
        <img
          src={avLogo}
          alt="American Viewpoint"
          style={{ height: 40, width: "auto", display: "block" }}
        />
      </div>
      <nav style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <NavLink to="/bot" style={linkStyle}>Verbatims</NavLink>
        <NavLink to="/toplines" style={linkStyle}>Memos</NavLink>
        <button className="btn btn-secondary" onClick={onLogout} style={{ marginLeft: 8 }}>
          Log out
        </button>
      </nav>
    </header>
  );
}

export default function RouterApp() {
  const [authed, setAuthed] = useState(() => {
    try { return localStorage.getItem(AUTH_KEY) === "1"; } catch { return false; }
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
      <Nav onLogout={() => setAuthed(false)} />
      <Suspense fallback={<div style={{ padding: 16 }}>Loading…</div>}>
        <Routes>
          <Route path="/" element={<Navigate to="/bot" replace />} />
          <Route path="/bot" element={<KnowledgeBotApp />} />
          <Route path="/toplines" element={<ToplinesApp />} />
          <Route path="*" element={<div style={{ padding: 16 }}>Not found.</div>} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
