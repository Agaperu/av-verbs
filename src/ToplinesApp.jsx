// ToplinesApp.jsx
import React, { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import Papa from "papaparse";
import axios from "axios";
import { Upload, Download, FileText, AlertCircle, CheckCircle } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList, Cell
} from "recharts";

import logoUrl from "./assets/av-logo3.png";
import logoGif from "./assets/av-logo-gif-no_background.gif";

/* ===================== Shared helpers & constants (matches your App.jsx style) ===================== */

const MAX_INPUT_CHARS = 120000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST with backoff and good error messages for OpenAI.
 * - Shows useful errors for 400/401/403 right away
 * - Retries on 429 and 5xx with exponential backoff
 */
async function postChatWithBackoff(
  url,
  body,
  headers,
  { maxRetries = 4, initialDelayMs = 1500, jitterMs = 400 } = {}
) {
  let attempt = 0, delay = initialDelayMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await axios.post(url, body, { headers, timeout: 30000 });
    } catch (err) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      const msg = data?.error?.message || data?.message || err.message || String(err);

      // For client-side issues (except 429), don't keep retrying — show error
      if (status && status < 500 && status !== 429) {
        const e = new Error(`OpenAI error (${status}): ${msg}`);
        e.status = status;
        throw e;
      }

      // Network or unexpected issue without a retriable code
      if (status !== 429 && (!status || status < 500)) {
        const e = new Error(`Request failed: ${msg}`);
        e.status = status || 0;
        throw e;
      }

      // 429 or 5xx → backoff
      attempt++;
      if (attempt > maxRetries) {
        const e = new Error(`OpenAI backoff failed after ${attempt} attempts: ${msg}`);
        e.status = status || 0;
        throw e;
      }

      const ra = err.response?.headers?.["retry-after"];
      const waitMs = ra ? Math.ceil(Number(ra) * 1000) : (delay + Math.floor(Math.random() * jitterMs));
      console.warn(`Backoff (${status}) attempt ${attempt} — waiting ${waitMs}ms…`, msg);
      await sleep(waitMs);
      delay = Math.min(12000, delay * 2);
    }
  }
}

// Column detection like your App.jsx
const QUESTION_COL_RE = /^q\d+/i;
const detectQuestionColumns = (rows) => {
  if (!rows?.length || typeof rows[0] !== "object") return [];
  const columns = Object.keys(rows[0]);
  return columns.filter((c) => QUESTION_COL_RE.test(String(c)));
};

// ID column helpers (kept for parity / future use)
const COMMON_ID_NAMES = [
  "respid","record","responseid","response_id",
  "respondentid","respondent_id","participantid","participant_id",
  "id","user_id","userid","caseid","case_id"
];
const detectIdColumn = (rows) => {
  if (!rows?.length || typeof rows[0] !== "object") return null;
  const headers = Object.keys(rows[0]);
  const lc = headers.map((h) => h.toLowerCase());
  for (const name of COMMON_ID_NAMES) {
    const idx = lc.indexOf(name);
    if (idx !== -1) return headers[idx];
  }
  return null;
};
const resolveIdColumn = (rows, desired) => {
  if (!rows?.length || typeof rows[0] !== "object") return desired || "";
  const cols = Object.keys(rows[0]);
  if (!desired) return "";
  return cols.find((c) => c.toLowerCase() === String(desired).toLowerCase()) ?? desired;
};

// Placeholders for meaningful-text gating (we use it for AI summary payload shaping)
const PLACEHOLDERS = new Set(["", " ", "na", "n a", "n/a", "none", "no response", "no comment", "nil", ".", "-", "--"]);
const normalizePlaceholder = (s) => (s || "").toString().replace(/[^0-9A-Za-z]+/g, " ").trim().toLowerCase();
const isMeaningful = (text, minChars = 1) => {
  const s = (text || "").toString().trim();
  if (s.length < minChars) return false;
  const norm = normalizePlaceholder(s);
  if (PLACEHOLDERS.has(norm)) return false;
  return true;
};

/* ===================== Toplines-specific helpers ===================== */

// Weighted frequency table: returns [{ val, pct, w }]
function weightedFreq(rows, valueCol, weightCol) {
  const sums = new Map(); // key: string value => sumW
  let total = 0;

  for (const row of rows) {
    let v = row?.[valueCol];
    if (v == null || v === "") v = "Missing";
    v = String(v);

    const w = Number(weightCol ? (row?.[weightCol] ?? 0) : 1) || (weightCol ? 0 : 1);
    if (w <= 0) continue;

    sums.set(v, (sums.get(v) || 0) + w);
    total += w;
  }

  const arr = Array.from(sums.entries()).map(([val, w]) => ({
    val,
    w,
    pct: total > 0 ? (w / total) * 100 : 0,
  }));
  arr.sort((a, b) => b.pct - a.pct);
  return arr;
}

// Build AI summary prompt from per-question tables (Total + demo splits)
const STYLE_PROMPTS = {
  "Executive Brief": "Write a single clear paragraph summarizing the key findings in a professional, executive-ready tone.",
  "Bullet-Point Insights": "Write 3–5 bullet points highlighting the key findings. Be concise, like topline insights in a slide deck.",
  "Detailed Narrative": "Write a detailed narrative (2–3 paragraphs) describing the key findings and demographic differences, as if for an analyst memo.",
};
function buildSummaryPrompt(questionLabel, demosDict, styleKey) {
  let text = `Survey question: ${questionLabel}\n\n`;
  Object.entries(demosDict).forEach(([demoName, tbl]) => {
    text += `${demoName}:\n`;
    tbl.forEach((r) => {
      text += ` - ${String(r.val)}: ${r.pct.toFixed(1)}%\n`;
    });
    text += "\n";
  });

  return `${STYLE_PROMPTS[styleKey]}

Data:
${text}`;
}

// Build a tidy long CSV out of toplines dict
function toplinesToLong(toplinesDict) {
  const rows = [];
  Object.entries(toplinesDict).forEach(([q, groups]) => {
    Object.entries(groups).forEach(([grp, tbl]) => {
      tbl.forEach((r) => {
        rows.push({
          Question: q,
          Group: grp,
          Value: String(r.val),
          Percent: Number(r.pct.toFixed(4)),
        });
      });
    });
  });
  return rows;
}

// Download helper
function downloadCsv(rows, filename) {
  const csv = Papa.unparse(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ===================== Color palette (Option B: consistent per label) ===================== */
// Your requested colors:
const COLOR_PALETTE = [
  "#c30808", // --milano-red
  "#f0f2f3", // --porcelain
  "#1464a2", // --fun-blue
  "#6d97b5", // --ship-cove
  "#870f10", // --tamarillo
  "#90bfdb", // --morning-glory
  "#10416a", // --chathams-blue
  "#5196c1", // --steel-blue
  "#042c5c", // --green-vogue
  "#448ccc", // --shakespeare
];

// Stable color assignment based on the answer label text
function colorForLabel(label) {
  let hash = 0;
  const str = String(label);
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % COLOR_PALETTE.length;
  return COLOR_PALETTE[idx];
}

/* ===================== Reusable UI: Searchable multi-checkbox ===================== */

function MultiCheckList({
  title,
  items,
  selected,
  onChange,
  showSearch = true,
  placeholder = "Filter...",
  maxHeight = 220,
}) {
  const [query, setQuery] = React.useState("");

  const normalized = (s) => (s || "").toString().toLowerCase();
  const filtered = !query
    ? items
    : items.filter((x) => normalized(x).includes(normalized(query)));

  const allSelected = filtered.length > 0 && filtered.every((x) => selected.includes(x));
  const someSelected = filtered.some((x) => selected.includes(x));

  const toggle = (val) => {
    if (selected.includes(val)) onChange(selected.filter((x) => x !== val));
    else onChange([...selected, val]);
  };

  const selectAll = () => {
    const set = new Set([...selected, ...filtered]);
    onChange(Array.from(set));
  };

  const clearFiltered = () => {
    onChange(selected.filter((x) => !filtered.includes(x)));
  };

  return (
    <div className="form-group">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <label style={{ fontWeight: 600 }}>{title}</label>
        <div style={{ fontSize: 12, color: "#4A5568" }}>
          {selected.length} selected
        </div>
      </div>

      {showSearch && (
        <div style={{ marginBottom: 8 }}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            style={{
              width: "100%", padding: "6px 8px", borderRadius: 6,
              border: "1px solid #e2e8f0", outline: "none", fontSize: "0.85rem"
            }}
          />
        </div>
      )}

      {/* compact utility buttons */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={selectAll}
          disabled={filtered.length === 0 || allSelected}
          style={{
            padding: "3px 8px",
            fontSize: "0.75rem",
            borderRadius: "4px",
            background: "#f7fafc",
            border: "1px solid #cbd5e0",
            cursor: "pointer",
            color: "#2d3748"
          }}
        >
          Select all
        </button>
        <button
          type="button"
          onClick={clearFiltered}
          disabled={!someSelected}
          style={{
            padding: "3px 8px",
            fontSize: "0.75rem",
            borderRadius: "4px",
            background: "#f7fafc",
            border: "1px solid #cbd5e0",
            cursor: "pointer",
            color: "#2d3748"
          }}
        >
          Clear
        </button>
      </div>

      {/* Responsive grid list (with light gray container) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 8,
          maxHeight,
          overflow: "auto",
          border: "1px solid #e2e8f0",
          borderRadius: 8,
          padding: 8,
          background: "#f7fafc", // light gray for visibility
        }}
      >
        {filtered.map((h) => {
          const checked = selected.includes(h);
          return (
            <label
              key={h}
              style={{
                display: "grid",
                gridTemplateColumns: "18px 1fr",
                alignItems: "center",
                gap: 6,
                border: "1px solid rgba(0,0,0,0.08)",
                borderRadius: 6,
                padding: "4px 6px",
                cursor: "pointer",
                fontSize: "0.8rem",
                lineHeight: 1.3,
                background: checked ? "rgba(0, 69, 127, 0.08)" : "white",
              }}
              title={h}
            >
              <input type="checkbox" checked={checked} onChange={() => toggle(h)} style={{ margin: 0 }} />
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {h}
              </span>
            </label>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ color: "#718096", fontSize: 13, gridColumn: "1 / -1" }}>
            No matches
          </div>
        )}
      </div>
    </div>
  );
}

/* ===================== Small Tabs component for the config card ===================== */

function ConfigTabs() {
  const tabStyle = ({ isActive }) => ({
    padding: '8px 12px',
    borderRadius: 6,
    fontWeight: 500,
    textDecoration: 'none',
    color: isActive ? 'white' : '#1a365d',
    background: isActive ? '#1a365d' : 'transparent',
    border: '1px solid rgba(0,0,0,0.10)',
  });

  return (
    <div className="config-tabs" style={{ display: 'flex', gap: 8, marginBottom: '1rem' }}>
      <NavLink to="/bot" style={tabStyle}>Verbatims</NavLink>
      <NavLink to="/toplines" style={tabStyle}>Memos</NavLink>
    </div>
  );
}

/* ===================== Overview helpers & components ===================== */

function groupNamesForQuestion(qToplines) {
  return Object.keys(qToplines || {});
}

function normalizeChartData(table) {
  // table is [{ val, pct, w }]
  return (table || []).map((r) => ({
    name: String(r.val),
    value: Number(r.pct || 0),
    fill: colorForLabel(String(r.val)),
  }));
}

function QuestionBlock({ q, groups, summaries, selectedGroup, onChangeGroup }) {
  const groupList = groupNamesForQuestion(groups);
  const safeGroup = groupList.includes(selectedGroup) ? selectedGroup : (groupList[0] || "Total");
  const table = groups[safeGroup] || [];
  const data = normalizeChartData(table);

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>{q}</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 12, color: "#4A5568" }}>Group:</label>
          <select
            value={safeGroup}
            onChange={(e) => onChangeGroup(q, e.target.value)}
            style={{ padding: "4px 8px", borderRadius: 6 }}
          >
            {groupList.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
      </div>

      <div style={{ width: "100%", height: 220 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} height={40} interval={0} />
            <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} />
            <Tooltip />
            <Bar dataKey="value" isAnimationActive>
              <LabelList dataKey="value" position="top" formatter={(v) => `${v.toFixed(1)}%`} />
              {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {summaries?.[q] && (
        <div style={{ marginTop: 8, padding: 10, background: "#f7fafc", borderRadius: 8, fontSize: "0.9rem", whiteSpace: "pre-wrap" }}>
          {summaries[q]}
        </div>
      )}
    </div>
  );
}

/* ===================== Component ===================== */

export default function ToplinesApp() {
  // Left column state (API + CSV)
  const [apiKey, setApiKey] = useState(() => {
    try { return localStorage.getItem('AV_API_KEY') || ""; } catch { return ""; }
  });
  useEffect(() => {
    try {
      if (apiKey) localStorage.setItem('AV_API_KEY', apiKey);
      else localStorage.removeItem('AV_API_KEY');
    } catch {}
  }, [apiKey]);

  const [csvData, setCsvData] = useState(null);
  const [fileName, setFileName] = useState("");
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  // Analysis selections (now in main card with Generate)
  const [weightCol, setWeightCol] = useState("");   // "" = none
  const [demoCols, setDemoCols] = useState([]);
  const [questionCols, setQuestionCols] = useState([]);
  const [styleChoice, setStyleChoice] = useState("Executive Brief");

  // Main controls / outputs
  const [modelName, setModelName] = useState("gpt-4o-mini");  // valid default model
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showPreview, setShowPreview] = useState(false);

  // Results
  const [toplines, setToplines] = useState(null);     // { [q]: { 'Total': [{val,pct,w}], 'Gender: Male': [...] , ... } }
  const [summaries, setSummaries] = useState(null);   // { [q]: "summary text" }

  // Per-question chosen group for the chart
  const [activeGroups, setActiveGroups] = useState({}); // { [q]: "Group Name" }
  const setActiveGroupForQ = (q, g) => setActiveGroups((prev) => ({ ...prev, [q]: g }));

  // Logo reset (same behavior as your App.jsx)
  function softReset() { try { localStorage.removeItem("app_version"); } catch {} window.location.reload(); }
  function hardReset() { try { localStorage.clear(); } catch {} window.location.reload(); }
  function handleLogoClick(e) {
    const hard = e.shiftKey || e.altKey;
    const msg = hard ? "Hard reset? This will clear ALL saved settings for this app." : "Reset saved settings?";
    if (window.confirm(msg)) { hard ? hardReset() : softReset(); }
  }

  /* ===================== File handlers ===================== */

  const handleFileUpload = (file) => {
    if (!file || !file.name.endsWith(".csv")) {
      setError("Please upload a valid CSV file.");
      return;
    }
    setError("");
    setSuccess("");
    setFileName(file.name);

    Papa.parse(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h) => h.replace(/^\uFEFF/, "").trim(),
      complete: (results) => {
        if (results.errors.length > 0) {
          setError("Error parsing CSV file. Please check the file format.");
          return;
        }
        const data = results.data;
        setCsvData(data);

        // initialize selectable columns
        if (data?.length) {
          setWeightCol("");         // default none
          setDemoCols([]);          // clear
          setQuestionCols(detectQuestionColumns(data)); // pre-fill Q columns if present
        }

        setSuccess(`Successfully loaded ${results.data.length} rows from ${file.name}`);
      },
      error: (err) => setError("Error reading CSV file: " + err.message),
    });
  };

  const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = (e) => { e.preventDefault(); setIsDragging(false); const file = e.dataTransfer.files[0]; handleFileUpload(file); };
  const handleFileInputChange = (e) => { const file = e.target.files[0]; handleFileUpload(file); };

  /* ===================== Generate toplines + summaries ===================== */

  async function generateToplines() {
    if (!csvData?.length) { setError("Please upload a CSV first."); return; }
    if (!questionCols.length) { setError("Please select at least one survey question column."); return; }

    setIsLoading(true);
    setError("");
    setSuccess("");

    try {
      // Build toplines object
      const newToplines = {};
      for (const q of questionCols) {
        // Total
        newToplines[q] = { Total: weightedFreq(csvData, q, weightCol || null) };

        // Each demo & level
        for (const demo of demoCols) {
          const levels = Array.from(
            new Set(csvData.map((r) => (r?.[demo] == null || r[demo] === "" ? "Missing" : String(r[demo]))))
          );
          for (const level of levels) {
            const subset = csvData.filter((r) => {
              const v = r?.[demo] == null || r[demo] === "" ? "Missing" : String(r[demo]);
              return v === level;
            });
            const key = `${demo}: ${level}`;
            newToplines[q][key] = weightedFreq(subset, q, weightCol || null);
          }
        }
      }

      // Optional: call OpenAI for summaries (per question) if apiKey present
      const newSummaries = {};
      if (apiKey.trim()) {
        const headers = { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" };
        for (const q of questionCols) {
          const prompt = buildSummaryPrompt(q, newToplines[q], styleChoice);
          const messages = [{ role: "user", content: prompt }];

          try {
            const body = { model: modelName, messages, temperature: 0.3 };
            const resp = await postChatWithBackoff("https://api.openai.com/v1/chat/completions", body, headers);
            newSummaries[q] = resp.data?.choices?.[0]?.message?.content?.trim() || "[Empty response]";
          } catch (err) {
            console.warn("AI summary failed:", err?.message || err);
            newSummaries[q] = `[AI Summary Error] ${err.message || String(err)}`;
          }

          await sleep(250); // be a little gentle
        }
      } else {
        // No key → explicit blank so UI can show why
        for (const q of questionCols) newSummaries[q] = "";
      }

      setToplines(newToplines);
      setSummaries(newSummaries);
      setSuccess("Memos generated!");
    } catch (err) {
      console.error(err);
      setError(err?.message || String(err));
    } finally {
      setIsLoading(false);
    }
  }

  /* ===================== Export ===================== */

  function exportCsv() {
    if (!toplines) { setError("Nothing to export yet."); return; }
    const rows = toplinesToLong(toplines);
    downloadCsv(rows, `toplines_long_${new Date().toISOString().slice(0,10)}.csv`);
    setSuccess("Exported CSV!");
  }

  /* ===================== UI ===================== */

  const headers = csvData?.length ? Object.keys(csvData[0]) : [];
  const qDetected = csvData?.length ? detectQuestionColumns(csvData) : [];
  const questionCandidates = Array.from(new Set([...(qDetected || []), ...headers]));

  return (
    <div className="container">
      {/* Header / Logo (reset like your App.jsx) */}
      <div className="header" style={{ display: "flex", justifyContent: "center", padding: "8px 0", marginBottom: "8px" }}>
        <button
          className="logo-button"
          onClick={handleLogoClick}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && handleLogoClick(e)}
          aria-label="Reset app"
          title="Click to reset (Shift/Alt + Click for hard reset)"
          style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", lineHeight: 0 }}
        >
          <img
            src={logoUrl}
            alt="American Viewpoint"
            className="logo-img"
            style={{ height: 150, width: "auto", maxWidth: "90vw", display: "block" }}
          />
        </button>
      </div>

      {/* Two-column layout to match your App.jsx */}
      <div className="layout">
        {/* LEFT: API + Upload + basic info / preview */}
        <aside className="sidebar">
          {/* API Key */}
          <div className="card">
            <h2>
              <img src={logoGif} alt="American Viewpoint" style={{ width: 20, height: 20, objectFit: "contain", marginRight: 8, verticalAlign: "middle" }} />{" "}
              OpenAI API Configuration
            </h2>

            {/* Tabs inside the card */}
            <ConfigTabs />

            <div className="form-group">
              <label htmlFor="apiKey">OpenAI API Key</label>
              <input
                type="password"
                id="apiKey"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Enter your OpenAI API key (optional for summaries)"
              />
            </div>
            <div className="form-group">
              <label htmlFor="modelSelect">Model</label>
              <select
                id="modelSelect"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                style={{ width: 260, padding: "6px 8px", borderRadius: 6 }}
              >
                <option value="gpt-4o-mini">gpt-4o-mini (fast, economical)</option>
                <option value="gpt-4o">gpt-4o (higher quality)</option>
              </select>
            </div>
          </div>

          {/* Upload */}
          <div className="card">
            <h2><Upload size={20} /> Upload CSV File</h2>
            <div className="form-group">
              <div
                className={`file-upload ${isDragging ? "dragover" : ""}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileText size={48} style={{ marginBottom: "1rem", color: "#00457f" }} />
                <p>Drag and drop your CSV file here, or click to browse</p>
                <p style={{ fontSize: "0.875rem", color: "#718096", marginTop: "0.5rem" }}>
                  {fileName || "No file selected"}
                </p>
              </div>
              <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileInputChange} style={{ display: "none" }} />
            </div>

            {csvData && (
              <div className="form-group">
                <p><strong>Loaded:</strong> {csvData.length} rows</p>
                {(() => {
                  const qcols = qDetected;
                  return qcols.length > 0 ? (
                    <p style={{ color: "#2f855a", fontSize: "0.875rem", marginTop: "0.5rem" }}>
                      ✅ Detected question columns: {qcols.join(", ")}
                    </p>
                  ) : (
                    <p style={{ color: "#e53e3e", fontSize: "0.875rem", marginTop: "0.5rem" }}>
                      ⚠️ No question columns found (Q1, Q2, Q24, etc.). Please check your CSV format.
                    </p>
                  );
                })()}

                {/* Preview + Clear */}
                <div className="actions" style={{ marginTop: 12 }}>
                  <button className="btn btn-secondary" onClick={() => setShowPreview(!showPreview)} style={{ marginRight: "0.5rem" }}>
                    {showPreview ? "Hide" : "Show"} Preview
                  </button>
                  <button className="btn btn-secondary" onClick={() => { setCsvData(null); setFileName(""); setToplines(null); setSummaries(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}>
                    Clear Data
                  </button>
                </div>

                {showPreview && (
                  <div style={{ marginTop: "1rem", padding: "1rem", background: "#f7fafc", borderRadius: "8px" }}>
                    <h4 style={{ marginBottom: "0.5rem" }}>Data Preview (First 5 rows):</h4>
                    <div style={{ maxHeight: "200px", overflow: "auto", fontSize: "0.875rem" }}>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                        {Papa.unparse(csvData.slice(0, 5))}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* RIGHT: Analyze + selectors + messages + results */}
        <main className="main">
          <div className="card">
            <h2>
              <img src={logoGif} alt="American Viewpoint" style={{ width: 20, height: 20, objectFit: "contain", marginRight: 8, verticalAlign: "middle" }} />{" "}
              Generate Memos
            </h2>

            {!csvData?.length && (
              <div style={{ marginTop: 8, color: "#718096", fontSize: "0.9rem" }}>
                Upload a CSV to enable analysis.
              </div>
            )}

            {/* ======= Selectors ======= */}
            {csvData?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                {/* Weight */}
                <div className="form-group">
                  <label>Weight Column (optional)</label>
                  <select
                    value={weightCol}
                    onChange={(e) => setWeightCol(e.target.value)}
                    style={{ width: 260, padding: "6px 8px", borderRadius: 6 }}  // match model dropdown
                  >
                    <option value="">(none)</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </div>

                {/* Demos */}
                <MultiCheckList
                  title="Demographic Breakouts"
                  items={headers}
                  selected={demoCols}
                  onChange={setDemoCols}
                  placeholder="Filter demographics…"
                />

                {/* Questions */}
                <MultiCheckList
                  title="Survey Questions (columns)"
                  items={questionCandidates}
                  selected={questionCols}
                  onChange={setQuestionCols}
                  placeholder="Filter questions…"
                />

                {/* Style */}
                <div className="form-group">
                  <label>Summary Style</label>
                  <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
                    {Object.keys(STYLE_PROMPTS).map((k) => (
                      <label
                        key={k}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          padding: "4px 12px",
                          borderRadius: 6,
                          cursor: "pointer",
                          whiteSpace: "nowrap"
                        }}
                      >
                        <input type="radio" name="style" value={k} checked={styleChoice === k} onChange={(e) => setStyleChoice(e.target.value)} />
                        <span>{k}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {/* ======= end selectors ======= */}

            <div className="actions" style={{ marginTop: 12 }}>
              <button className="btn" onClick={generateToplines} disabled={isLoading || !csvData?.length}>
                {isLoading ? (<><div className="spinner"></div>Generating…</>) : (<>Generate</>)}
              </button>
              <button className="btn btn-secondary" onClick={exportCsv} disabled={!toplines || isLoading}>
                <Download size={16} /> Export CSV
              </button>
            </div>
          </div>

          {error && (
            <div className="error">
              <AlertCircle size={20} style={{ marginRight: "0.5rem" }} />
              {error}
            </div>
          )}
          {success && (
            <div className="success">
              <CheckCircle size={20} style={{ marginRight: "0.5rem" }} />
              {success}
            </div>
          )}

          {toplines && (
            <div className="card">
              <h2>Overview</h2>

              {Object.entries(toplines).map(([q, groups]) => (
                <QuestionBlock
                  key={q}
                  q={q}
                  groups={groups}
                  summaries={summaries}
                  selectedGroup={activeGroups[q] || "Total"}
                  onChangeGroup={setActiveGroupForQ}
                />
              ))}

              {Object.keys(toplines).length === 0 && (
                <div style={{ color: "#718096" }}>No data to display.</div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
