// Chatbot.jsx
import React, { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import Papa from "papaparse";
import axios from "axios";
import { Upload, Send, FileText, AlertCircle, CheckCircle, X } from "lucide-react";
import logoUrl from "./assets/av-logo3.png";
import logoGif from "./assets/av-logo-gif-no_background.gif";

/* ===================== Shared constants & helpers (matches your apps) ===================== */

const MAX_INPUT_CHARS = 120000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function postChatWithBackoff(
  url,
  body,
  headers,
  { maxRetries = 6, initialDelayMs = 1500, jitterMs = 400 } = {}
) {
  let attempt = 0, delay = initialDelayMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await axios.post(url, body, { headers });
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429 || status >= 500) {
        attempt++;
        if (attempt > maxRetries) throw err;
        const ra = err.response?.headers?.["retry-after"];
        const waitMs = ra ? Math.ceil(Number(ra) * 1000) : delay + Math.floor(Math.random() * jitterMs);
        console.warn(`Backoff (${status}) attempt ${attempt}. Waiting ${waitMs}ms…`);
        await sleep(waitMs);
        delay = Math.min(12000, delay * 2);
        continue;
      }
      throw err;
    }
  }
}

/* ===================== Reusable Config Tabs (now includes Chatbot) ===================== */

function ConfigTabs() {
  const tabStyle = ({ isActive }) => ({
    padding: "8px 12px",
    borderRadius: 6,
    fontWeight: 500,
    textDecoration: "none",
    color: isActive ? "white" : "#1a365d",
    background: isActive ? "#1a365d" : "transparent",
    border: "1px solid rgba(0,0,0,0.10)",
  });

  return (
    <div className="config-tabs" style={{ display: "flex", gap: 8, marginBottom: "1rem" }}>
      <NavLink to="/bot" style={tabStyle}>Verbatims</NavLink>
      <NavLink to="/toplines" style={tabStyle}>Memos</NavLink>
      <NavLink to="/chat" style={tabStyle}>Chatbot</NavLink>
    </div>
  );
}

/* ===================== File helpers ===================== */

const ACCEPTED_TYPES = [
  "text/plain", "text/markdown", "text/csv", "application/json",
  // Others allowed (we’ll list, but not parse yet)
  "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
];
const ACCEPTED_EXTS = [".txt", ".md", ".csv", ".json", ".pdf", ".docx"];

function looksLike(exts, name) {
  const low = (name || "").toLowerCase();
  return exts.some((e) => low.endsWith(e));
}

async function readFileText(file) {
  const type = file.type || "";
  const name = file.name || "";

  // Basic text-like types we can parse quickly
  if (
    type.startsWith("text/") ||
    type === "application/json" ||
    looksLike([".txt", ".md", ".json"], name)
  ) {
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error);
      fr.onload = () => resolve(String(fr.result || ""));
      fr.readAsText(file);
    });
  }

  // CSV: use Papa to normalize → plain text
  if (type === "text/csv" || looksLike([".csv"], name)) {
    const csvText = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error);
      fr.onload = () => resolve(String(fr.result || ""));
      fr.readAsText(file);
    });
    try {
      const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: "greedy" });
      const rows = Array.isArray(parsed.data) ? parsed.data : [];
      // Flatten into a human-friendly previewable text block
      const headers = rows.length ? Object.keys(rows[0]) : [];
      const lines = [];
      lines.push(`COLUMNS: ${headers.join(", ")}`);
      const cap = Math.min(100, rows.length);
      for (let i = 0; i < cap; i++) {
        const r = rows[i] || {};
        const cells = headers.map((h) => `${h}=${String(r[h] ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
        lines.push(`row=${i + 1} | ${cells.join(" | ")}`);
      }
      if (rows.length > cap) lines.push(`... (${rows.length - cap} more rows not shown)`);
      return lines.join("\n");
    } catch {
      // Fall back to raw text if parse fails
      return csvText;
    }
  }

  // Unsupported parse right now (PDF/DOCX) → we include filename only
  return null;
}

/* ===================== Component ===================== */

export default function Chatbot() {
  // Persist API key just like other apps
  const [apiKey, setApiKey] = useState(() => {
    try { return localStorage.getItem("AV_API_KEY") || ""; } catch { return ""; }
  });
  useEffect(() => {
    try {
      if (apiKey) localStorage.setItem("AV_API_KEY", apiKey);
      else localStorage.removeItem("AV_API_KEY");
    } catch {}
  }, [apiKey]);

  const [modelName, setModelName] = useState("gpt-5"); // good default
  const [question, setQuestion] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Uploaded files: [{file, name, size, type, text|null}]
  const [files, setFiles] = useState([]);
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  // Simple chat history for the main area
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hi! Ask a question and optionally attach files. I’ll answer and reference them." }
  ]);

  function softReset() { try { localStorage.removeItem("app_version"); } catch {} window.location.reload(); }
  function hardReset() { try { localStorage.clear(); } catch {} window.location.reload(); }
  function handleLogoClick(e) {
    const hard = e.shiftKey || e.altKey;
    const msg = hard ? "Hard reset? This will clear ALL saved settings for this app." : "Reset saved settings?";
    if (window.confirm(msg)) { hard ? hardReset() : softReset(); }
  }

  /* ---------- File handlers ---------- */

  async function addFiles(list) {
    const arr = Array.from(list || []);
    const accepted = arr.filter((f) => {
      if (!f) return false;
      if (ACCEPTED_TYPES.includes(f.type)) return true;
      return looksLike(ACCEPTED_EXTS, f.name);
    });

    const newEntries = [];
    for (const f of accepted) {
      const text = await readFileText(f);
      newEntries.push({
        file: f,
        name: f.name,
        size: f.size,
        type: f.type || "",
        text, // null for pdf/docx for now
      });
    }
    setFiles((prev) => [...prev, ...newEntries]);
  }

  function removeFile(idx) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);
    await addFiles(e.dataTransfer.files);
  };
  const handleFileInputChange = async (e) => {
    await addFiles(e.target.files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  /* ---------- Ask model ---------- */

  async function ask() {
    if (!apiKey.trim()) { setError("Please enter your OpenAI API key."); return; }
    const q = question.trim();
    if (!q) { setError("Type a question to ask the model."); return; }

    setIsLoading(true);
    setError("");
    setSuccess("");

    // Build a compact file context block
    // We’ll include up to MAX_INPUT_CHARS of text across all readable files.
    let remaining = MAX_INPUT_CHARS - q.length - 2000; // keep budget for instructions & reply
    const readable = files.filter((f) => typeof f.text === "string" && f.text.length > 0);
    const listedOnly = files.filter((f) => f.text == null);

    const fileBlocks = [];
    for (const f of readable) {
      if (remaining <= 0) break;
      const take = Math.max(0, Math.min(remaining, f.text.length));
      const chunk = f.text.slice(0, take);
      remaining -= take;
      fileBlocks.push(
        `=== FILE: ${f.name} (truncated) ===\n${chunk}\n=== END FILE: ${f.name} ===`
      );
    }

    const listNames = listedOnly.map((f) => `- ${f.name} (${f.type || "unknown"})`);
    const listNote = listedOnly.length
      ? `\nUnparsed attachments included for context only (no text extracted yet):\n${listNames.join("\n")}\n`
      : "";

    const userBlock =
`Question:
${q}

Instructions:
- Use the attached file texts to answer when relevant.
- When you cite, reference the filename(s) that support your answer.
- If a file wasn’t parsed (e.g., PDF/DOCX), say so and answer using parsed files only.

${listNote}
${fileBlocks.join("\n\n")}`;

    const history = messages.slice(-10); // keep it light
    const chatMessages = [
      { role: "system", content: "You are a precise research assistant. If you reference files, cite them by filename." },
      ...history,
      { role: "user", content: userBlock },
    ];

    try {
      const headers = { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" };
      const body = { 
        model: modelName, 
        messages: chatMessages, 
        ... (modelName !== "gpt-5" ? {temperature: 0.2 } : {})
      };
      const resp = await postChatWithBackoff("https://api.openai.com/v1/chat/completions", body, headers);
      const content = resp?.data?.choices?.[0]?.message?.content ?? "(No content returned)";

      setMessages((prev) => [...prev, { role: "user", content: q }, { role: "assistant", content }]);
      setQuestion("");
      setSuccess("Answer generated.");
    } catch (err) {
      const status = err?.response?.status;
      const msg = err?.response?.data?.error?.message || err.message || String(err);
      setError(`OpenAI API Error${status ? ` (${status})` : ""}: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  }

  function clearChat() {
    setMessages([{ role: "assistant", content: "Chat cleared. Ask another question anytime." }]);
    setError("");
    setSuccess("");
  }

  /* ===================== Render ===================== */

  return (
    <div className="container">
      {/* Header */}
      <div className="header" style={{ display: "flex", justifyContent: "center", padding: "8px 0", marginBottom: "8px" }}>
        <img
            src={logoUrl}
            alt="American Viewpoint"
            className="logo-img"
            style={{ height: 150, width: "auto", maxWidth: "90vw", display: "block" }}
          />{" "}
      </div>

      <div className="layout">
        {/* LEFT: Configuration */}
        <aside className="sidebar">
          <div className="card">
            <h2>
            <img src={logoGif} alt="American Viewpoint" style={{ width: 20, height: 20, objectFit: "contain", marginRight: 8, verticalAlign: "middle" }} />{" "}
            OpenAI API Configuration</h2>
            <ConfigTabs />

            <div className="form-group">
              <label htmlFor="apiKey">OpenAI API Key</label>
              <input
                type="password"
                id="apiKey"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
            </div>

            <div className="form-group">
              <label htmlFor="modelName">Model</label>
              <select
                id="modelName"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                style={{ width: "100%", padding: "0.5rem", borderRadius: 8, border: "2px solid #e2e8f0" }}
              >
                <option value="gpt-5">GPT-5 (Best quality)</option>
                <option value="gpt-4o-mini">GPT-4o-mini (Fast & cheap)</option>
                <option value="gpt-4o">GPT-4o</option>
              </select>
            </div>

            <div className="form-group">
              <button className="btn btn-secondary" onClick={clearChat} type="button">
                Clear chat
              </button>
            </div>

            {error && (
              <div className="error" role="alert">
                <strong style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <AlertCircle size={16} /> Error
                </strong>
                <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{error}</div>
              </div>
            )}
            {success && (
              <div className="success" role="status">
                <strong style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <CheckCircle size={16} /> Success
                </strong>
                <div style={{ marginTop: 6 }}>{success}</div>
              </div>
            )}
          </div>

          {/* Upload card */}
          <div className="card">
            <h2>
            <img src={logoGif} alt="American Viewpoint" style={{ width: 20, height: 20, objectFit: "contain", marginRight: 8, verticalAlign: "middle" }} />{" "}
            Attach files (optional)</h2>
            <div
              className={`file-upload ${isDragging ? "dragover" : ""}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
            >
              <Upload style={{ marginRight: 8 }} />
              <span>Click or drag & drop files here</span>
              <div style={{ marginTop: 8, fontSize: 12, color: "#4A5568" }}>
                Supported now: .txt, .md, .csv, .json (previewed). PDF/DOCX allowed but not parsed yet.
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPTED_EXTS.join(",")}
                onChange={handleFileInputChange}
                style={{ display: "none" }}
              />
            </div>

            {files.length > 0 && (
              <div style={{ marginTop: 12 }}>
                {files.map((f, i) => (
                  <div
                    key={`${f.name}-${i}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 8,
                      background: "#f7fafc",
                      marginBottom: 8
                    }}
                    title={f.name}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <FileText size={16} />
                      <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {f.name} <span style={{ color: "#718096", fontSize: 12 }}>({Math.round(f.size / 1024)} KB)</span>
                        {f.text == null && <span style={{ marginLeft: 6, color: "#c05621", fontSize: 12 }}>(not parsed)</span>}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      title="Remove"
                      aria-label={`Remove ${f.name}`}
                      style={{
                        background: "transparent",
                        border: "1px solid #e2e8f0",
                        borderRadius: 6,
                        padding: "4px 6px",
                        cursor: "pointer"
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* RIGHT: Chat area */}
        <main className="main">
          <div className="card">
            <h2>
            <img src={logoGif} alt="American Viewpoint" style={{ width: 20, height: 20, objectFit: "contain", marginRight: 8, verticalAlign: "middle" }} />{" "}
            Chat</h2>

            {/* Transcript */}
            <div
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                padding: 12,
                background: "#f7fafc",
                maxHeight: 380,
                overflow: "auto",
                marginBottom: 12
              }}
            >
              {messages.map((m, idx) => (
                <div
                  key={idx}
                  style={{
                    background: m.role === "assistant" ? "white" : "rgba(0, 69, 127, 0.06)",
                    border: "1px solid rgba(0,0,0,0.06)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    marginBottom: 8,
                    whiteSpace: "pre-wrap"
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#4A5568", marginBottom: 4 }}>
                    {m.role === "assistant" ? "Assistant" : "You"}
                  </div>
                  <div>{m.content}</div>
                </div>
              ))}
              {isLoading && (
                <div className="loading" style={{ padding: 6 }}>
                  <div className="spinner" /> Generating answer…
                </div>
              )}
            </div>

            {/* Prompt box */}
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label htmlFor="question">Ask a question</label>
              <textarea
                id="question"
                rows={3}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g., Summarize key takeaways from the attached docs and cite file names."
              />
            </div>

            <div className="actions" style={{ justifyContent: "space-between" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button className="btn" type="button" onClick={ask} disabled={isLoading}>
                  <Send size={16} /> Ask
                </button>
                <button className="btn btn-secondary" type="button" onClick={() => setQuestion("")} disabled={isLoading}>
                  Clear input
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
