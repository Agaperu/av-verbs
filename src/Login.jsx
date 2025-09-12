// src/Login.jsx
import React, { useState } from "react";
import logoUrl from "./assets/av-logo3.png";

const AUTH_KEY = "av_authed_v1";

export default function Login({ onSuccess }) {
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");

  // Build-time env var (Netlify/Vite): VITE_LOGIN_PASS
  const expected =
    (import.meta?.env && import.meta.env.VITE_LOGIN_PASS) || "amview1985";

  function handleSubmit(e) {
    e.preventDefault();
    if ((pass || "").trim() === String(expected)) {
      try { localStorage.setItem(AUTH_KEY, "1"); } catch {}
      onSuccess?.();
    } else {
      setError("Incorrect passphrase. Please try again.");
    }
  }

  return (
    <div className="login-backdrop">
      <div className="login-card" role="dialog" aria-modal="true">
        <img src={logoUrl} alt="American Viewpoint" className="login-logo" />
        <h1 className="login-title">Sign in</h1>
        <p className="login-subtitle">Enter passphrase to access the app</p>

        <form onSubmit={handleSubmit} className="login-form">
          <label className="login-label" htmlFor="pass">Passphrase</label>
          <input
            id="pass"
            type="password"
            className="login-input"
            placeholder="••••••••"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoFocus
          />

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="btn login-btn">Continue</button>
        </form>

        <div className="login-note">
          {/* Tip: set <code>VITE_LOGIN_PASS</code> in your Netlify env vars. */}
        </div>
      </div>
    </div>
  );
}
