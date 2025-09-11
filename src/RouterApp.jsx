// RouterApp.jsx
import React, { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";

// Reuse your existing App.jsx as the "Knowledge Bot" view
import KnowledgeBotApp from "./App";          // your current app
import ToplinesApp from "./ToplinesApp";      // the toplines app we made

function Nav() {
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
    <header style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "12px 16px",
      marginBottom: 10,
      borderBottom: "1px solid rgba(0,0,0,0.08)",
      background: "var(--background-color, #fff)"
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* If you have a shared logo, drop it here */}
        {/* <img src={logoUrl} alt="American Viewpoint" style={{ height: 36 }} /> */}
        <strong style={{ fontSize: 18 }}>American Viewpoint Tools</strong>
      </div>
      <nav style={{ display: "flex", gap: 8 }}>
        <NavLink to="/bot" style={linkStyle}>Knowledge Bot</NavLink>
        <NavLink to="/toplines" style={linkStyle}>Memos</NavLink>
      </nav>
    </header>
  );
}

export default function RouterApp() {
  return (
    <BrowserRouter>
      <Nav />
      <Suspense fallback={<div style={{ padding: 16 }}>Loading…</div>}>
        <Routes>
          {/* Default → Knowledge Bot */}
          <Route path="/" element={<Navigate to="/bot" replace />} />
          <Route path="/bot" element={<KnowledgeBotApp />} />
          <Route path="/toplines" element={<ToplinesApp />} />
          {/* 404 */}
          <Route path="*" element={<div style={{ padding: 16 }}>Not found.</div>} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
