// App.jsx — adds selective “Edit & Reassign Themes” with robust merge/split ops + fixed file upload
import React, { useState, useRef, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import Papa from 'papaparse';
import axios from 'axios';
import { Upload, Download, FileText, Brain, AlertCircle, CheckCircle } from 'lucide-react';
import logoUrl from './assets/av-logo3.png';
import logoGif from './assets/av-logo-gif-no_background.gif';

/* ===================== Python-style constants & helpers ===================== */

// Match Python’s big cap (be mindful of your model/rate limits)
const MAX_INPUT_CHARS = 120000;

// Simple backoff for 429 / 5xx (honors Retry-After)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function postChatWithBackoff(url, body, headers, { maxRetries = 6, initialDelayMs = 1500, jitterMs = 400 } = {}) {
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
        const ra = err.response?.headers?.['retry-after'];
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

// Strict question detector like Python: ^q\d+ (Q24, Q25, q10a ok)
const QUESTION_COL_RE = /^q\d+/i;
const detectQuestionColumns = (data) => {
  if (!data?.length || typeof data[0] !== 'object') return [];
  const columns = Object.keys(data[0]);
  return columns.filter((c) => QUESTION_COL_RE.test(String(c)));
};

// Case-insensitive resolver for ID column (Python expects exact; we’re friendlier)
const resolveIdColumn = (rows, desired) => {
  if (!rows?.length || typeof rows[0] !== 'object') return desired || '';
  const cols = Object.keys(rows[0]);
  if (!desired) return '';
  return cols.find((c) => c.toLowerCase() === String(desired).toLowerCase()) ?? desired;
};

// Auto-detect ID col if none provided
const COMMON_ID_NAMES = [
  'respid','record','responseid','response_id',
  'respondentid','respondent_id','participantid','participant_id',
  'id','user_id','userid','caseid','case_id'
];
const detectIdColumn = (rows) => {
  if (!rows?.length || typeof rows[0] !== 'object') return null;
  const headers = Object.keys(rows[0]);
  const lc = headers.map((h) => h.toLowerCase());
  for (const name of COMMON_ID_NAMES) {
    const idx = lc.indexOf(name);
    if (idx !== -1) return headers[idx];
  }
  return null;
};

// === “Meaningful” text gate (w/ common placeholders) ===
const PLACEHOLDERS = new Set(['', ' ', 'na', 'n a', 'n/a', 'none', 'no response', 'no comment', 'nil', '.', '-', '--']);
const normalizePlaceholder = (s) =>
  (s || '').toString().replace(/[^0-9A-Za-z]+/g, ' ').trim().toLowerCase();

const isMeaningful = (text, minChars = 3) => {
  const s = (text || '').toString().trim();
  if (s.length < minChars) return false;
  const norm = normalizePlaceholder(s);
  if (PLACEHOLDERS.has(norm)) return false;
  return true;
};

// Build Python-like payload lines up to MAX_INPUT_CHARS
function buildPayloadForColumn(rows, idCol, colName, maxChars = MAX_INPUT_CHARS, skipBlanks = true) {
  const lines = [];
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const rid = String(rows[i]?.[idCol] ?? (i + 1));
    const raw = rows[i]?.[colName];
    const txt = String(raw ?? '').replace(/\n/g, ' ').trim();

    // honor toggle
    if (skipBlanks) {
      if (!isMeaningful(txt)) continue;
    } else {
      if (!txt) continue;
    }

    const line = `record=${rid} | response=${txt}`;
    const add = line.length + 1;
    if (total + add > maxChars) break;
    lines.push(line);
    total += add;
  }
  return lines.join('\n');
}

// Python-style lenient JSON parser
function parseJsonMaybe(text) {
  if (text == null) return [];
  let t = String(text).trim();

  // Strip backticks and language fences
  if (t.startsWith('```')) {
    t = t.replace(/^```+/, '').trim();
    t = t.replace(/^json/i, '').trim();
    t = t.replace(/```+$/, '').trim();
  }

  // First try straight parse
  try {
    return JSON.parse(t);
  } catch (_) {
    // Try to extract the outermost array block
    const i = t.indexOf('[');
    const j = t.lastIndexOf(']');
    if (i !== -1 && j !== -1 && j > i) {
      const slice = t.slice(i, j + 1);
      try {
        return JSON.parse(slice);
      } catch (_) { /* fallthrough */ }
    }
    // Try to extract outermost object (rare)
    const oi = t.indexOf('{');
    const oj = t.lastIndexOf('}');
    if (oi !== -1 && oj !== -1 && oj > oi) {
      const slice = t.slice(oi, oj + 1);
      try {
        return JSON.parse(slice);
      } catch (_) { /* fallthrough */ }
    }
  }
  // Let caller handle parse failure
  throw new Error('JSON parse failed');
}

/* ===== NEW: compute question-level respondent universe (for % coverage) ===== */
function computeQuestionUniverse(rows, idCol, qcol, skipBlanks = true) {
  const set = new Set();
  if (!Array.isArray(rows) || rows.length === 0) return set;
  for (let i = 0; i < rows.length; i++) {
    const rid = String(rows[i]?.[idCol] ?? (i + 1));
    const raw = rows[i]?.[qcol];
    const txt = String(raw ?? '').replace(/\n/g, ' ').trim();
    const include = skipBlanks ? isMeaningful(txt) : !!txt;
    if (include) set.add(rid);
  }
  return set;
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

/* ===================== Component ===================== */

function App() {
  const [apiKey, setApiKey] = useState('');
  const [csvData, setCsvData] = useState(null);
  const [fileName, setFileName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [modelName, setModelName] = useState('gpt-5');
  const [showPreview, setShowPreview] = useState(false);
  const [outputFormat] = useState('long'); // kept for compatibility
  const [questionId, setQuestionId] = useState(''); // optional filter (e.g., q24)
  const [idColumn, setIdColumn] = useState('respid'); // default like Python
  const [skipBlankCells, setSkipBlankCells] = useState(true); // remove blanks/placeholders
  const fileInputRef = useRef(null);

  const defaultPrompt = `Your role: You are a senior survey research analyst.
Your task: Read the list of open-ended responses to the survey question, <INSERT SURVEY QUESTION(S) HERE>, in the attached csv and identify the key themes. It is CRUCIAL that every ParticipantID goes into AT LEAST one theme category for each question. You may include categories for 'Other', 'Don't Know', and 'Refused' if needed.
Instructions: 
1) Identify 6-9 themes that capture the main ideas expressed. 
2) For each theme, provide: 
- ThemeLabel (3–5 neutral words) 
- Definition (short, factual) 
- RepresentativeKeywords (5–10 indicative words/phrases) 
- ParticipantID (row numbers that correspond to the theme)
3) Output ONLY JSON in this format: 
[ 
{ 
"ThemeLabel": "Theme Name", 
"Definition": "Short definition.", 
"RepresentativeKeywords": ["keyword1", "keyword2"],
"ParticipantID": ["row number1", "row number2"]
 }
]`;

  /* === Editable Analysis Prompt (persisted) === */
  const [analysisPrompt, setAnalysisPrompt] = useState(() => {
    try {
      return localStorage.getItem('analysisPrompt') || defaultPrompt;
    } catch {
      return defaultPrompt;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('analysisPrompt', analysisPrompt);
    } catch { /* ignore */ }
  }, [analysisPrompt]);

  const resetPromptToDefault = () => setAnalysisPrompt(defaultPrompt);

  /* === NEW: Editable Edit Prompt (persisted) — supports ops: merge/split/replace/delete/insert === */
  const defaultEditPrompt = `You will revise ONLY the selected themes. Keep all other themes unchanged unless the operation (merge/split/delete) demands structural changes.

ALLOWED OPERATIONS (return an array of JSON objects, each with an "op"):

1) MERGE
{
  "op": "merge",
  "indices": [i, j, ...],
  "ThemeLabel": "…",
  "Definition": "…",
  "RepresentativeKeywords": ["…"],
  "ParticipantID": ["…"],
  "insertIndex": k
}

2) SPLIT
{
  "op": "split",
  "index": i,
  "replacements": [
    { "ThemeLabel":"…","Definition":"…","RepresentativeKeywords":["…"],"ParticipantID":["…"] },
    { "ThemeLabel":"…","Definition":"…","RepresentativeKeywords":["…"],"ParticipantID":["…"] }
  ],
  "insertIndex": k
}

3) REPLACE
{
  "op": "replace",
  "index": i,
  "theme": { "ThemeLabel":"…","Definition":"…","RepresentativeKeywords":["…"],"ParticipantID":["…"] }
}

4) DELETE
{
  "op": "delete",
  "indices": [i, j, ...]
}

5) INSERT
{
  "op": "insert",
  "index": k,
  "theme": { "ThemeLabel":"…","Definition":"…","RepresentativeKeywords":["…"],"ParticipantID":["…"] }
}

HARD RULES:
- Operate ONLY on the provided "selected indices" set; do not alter other themes except when removing them via merge/split/delete explicitly listed above.
- When MERGING, output exactly ONE merged theme that replaces ALL listed indices (do NOT return duplicates).
- When SPLITTING, completely remove the original theme and insert the provided replacements (fully assigned IDs).
- Always provide complete "ParticipantID" arrays for any created/replaced themes. Reassign IDs as needed so each ParticipantID remains in at least one theme for this question.
- Return STRICTLY VALID JSON: an array of op objects only (no commentary).`;

  const [editPrompt, setEditPrompt] = useState(() => {
    try {
      return localStorage.getItem('editPrompt') || defaultEditPrompt;
    } catch {
      return defaultEditPrompt;
    }
  });

  useEffect(() => {
    try { localStorage.setItem('editPrompt', editPrompt); } catch {}
  }, [editPrompt]);

  const resetEditPrompt = () => setEditPrompt(defaultEditPrompt);

  /* === Logo reset handlers (logo acts as reset button) === */
  const SOFT_RESET_KEYS = ['analysisPrompt', 'editPrompt', 'app_version'];

  function softReset() {
    try {
      SOFT_RESET_KEYS.forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
    window.location.reload();
  }
  function hardReset() {
    try { localStorage.clear(); } catch { /* ignore */ }
    window.location.reload();
  }
  function handleLogoClick(e) {
    const hard = e.shiftKey || e.altKey;
    const msg = hard
      ? 'Hard reset? This will clear ALL saved settings for this app.'
      : 'Reset saved settings? (API key is not cleared unless you store it in localStorage)';
    if (window.confirm(msg)) {
      hard ? hardReset() : softReset();
    }
  }

  /* ===================== File handlers ===================== */

  const handleFileUpload = (file) => {
    // FIX: robust CSV guard (case-insensitive, also allows text/csv)
    if (!file || !/\.csv$/i.test(file.name)) {
      setError('Please upload a valid CSV file (.csv).');
      return;
    }

    setFileName(file.name);
    setError('');
    setSuccess('');

    Papa.parse(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.replace(/^\uFEFF/, '').trim(),
      complete: (results) => {
        if (results.errors.length > 0) {
          setError('Error parsing CSV file. Please check the file format.');
          return;
        }
        setCsvData(results.data);

        // If the user left the default, try to auto-detect a better ID column
        if (idColumn === 'respid') {
          const auto = detectIdColumn(results.data);
          if (auto) setIdColumn(auto);
        }

        setSuccess(`Successfully loaded ${results.data.length} rows from ${file.name}`);
      },
      error: (err) => {
        setError('Error reading CSV file: ' + err.message);
      }
    });
  };

  const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = (e) => { e.preventDefault(); setIsDragging(false); const file = e.dataTransfer.files[0]; handleFileUpload(file); };
  const handleFileInputChange = (e) => { const file = e.target.files[0]; handleFileUpload(file); };

  /* ===================== One-shot analysis (Python-like) ===================== */

  async function llmThemeExtract({ columnName, model, idCol, headers }) {
    const payload = buildPayloadForColumn(csvData, idCol, columnName, MAX_INPUT_CHARS, skipBlankCells);
    if (!payload || !payload.trim()) {
      return { ok: true, content: '[]' }; // nothing to analyze → empty array
    }

    const messages = [
      { role: 'system', content: 'You are a precise, compliance-focused data analyst. Output strictly valid JSON with no commentary.' },
      {
        role: 'user',
        content:
          `Analyze the following open-ended responses for column '${columnName}'.\n\n` +
          `${analysisPrompt}\n\n` +
          `Use the 'record' value as ParticipantID.\n\n` +
          `RESPONSES (one per line):\n${payload}`
      }
    ];

    try {
      // no temperature param at all
      const body = { model, messages };
      const resp = await postChatWithBackoff('https://api.openai.com/v1/chat/completions', body, headers);
      const content = resp.data?.choices?.[0]?.message?.content ?? '';
      return { ok: true, content };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  const analyzeData = async () => {
    if (!apiKey.trim()) {
      setError('Please enter your OpenAI API key.');
      return;
    }
    if (!csvData || csvData.length === 0) {
      setError('Please upload a CSV file first.');
      return;
    }

    setIsLoading(true);
    setError('');
    setSuccess('');

    try {
      const questionColumns = detectQuestionColumns(csvData);
      if (questionColumns.length === 0) {
        setIsLoading(false);
        setError('No question columns found (Q1, Q2, Q24, etc.). Please check your CSV format.');
        return;
      }

      // Resolve ID column (case-insensitive)
      let resolvedIdCol = resolveIdColumn(csvData, idColumn || 'respid');
      if (!csvData[0] || !(resolvedIdCol in csvData[0])) {
        const autoId = detectIdColumn(csvData);
        if (autoId && autoId in csvData[0]) {
          resolvedIdCol = autoId;
          setIdColumn(autoId);
        } else {
          setIsLoading(false);
          setError(
            `Expected an ID column like '${idColumn}' in the CSV. ` +
            `Available columns: ${Object.keys(csvData[0]).join(', ')}`
          );
          return;
        }
      }

      // Optional filter
      const qFilter = (questionId || '').trim().toLowerCase();
      let columnsToProcess = questionColumns;
      if (qFilter) {
        columnsToProcess = questionColumns.filter((c) => c.toLowerCase().startsWith(qFilter));
        if (columnsToProcess.length === 0) {
          setIsLoading(false);
          setError(`No columns match '${questionId}'. Found: ${questionColumns.join(', ')}`);
          return;
        }
      }

      const allResults = {};
      const headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      };
      const model = modelName;

      for (const col of columnsToProcess) {
        const r = await llmThemeExtract({ columnName: col, model, idCol: resolvedIdCol, headers });

        if (!r.ok) {
          const status = r.error?.response?.status;
          const msg = r.error?.response?.data?.error?.message || r.error?.message || String(r.error);
          allResults[col] = { _error: `HTTP ${status || ''} ${msg}`.trim() };
          await sleep(1200);
          continue;
        }

        // Parse: keep raw on failure
        try {
          const parsed = parseJsonMaybe(r.content);
          allResults[col] = parsed;
        } catch (_) {
          allResults[col] = { _raw: r.content };
        }

        await sleep(1200);
      }

      setResults(allResults);
      setSuccess(`Analysis completed for ${Object.keys(allResults).length} question column(s)!`);
    } catch (err) {
      console.error('API Error:', err);
      const msg = err?.response?.data?.error?.message || err.message;
      setError(`OpenAI API Error: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  };

  /* ===================== Export (LONG + WIDE) ===================== */

  const exportBothCSVs = () => {
    if (!results || Object.keys(results).length === 0) {
      setError('No results to export.');
      return;
    }
  
    try {
      // ---------- LONG (Question, ThemeLabel, Definition, Keywords, ParticipantIDs)
      const longRows = [];
      Object.entries(results).forEach(([questionCol, themes]) => {
        if (Array.isArray(themes)) {
          themes.forEach((theme, idx) => {
            const idsArr = Array.isArray(theme.ParticipantID)
              ? theme.ParticipantID
              : (theme.ParticipantID != null ? [theme.ParticipantID] : []);
            longRows.push({
              Question: questionCol,
              ThemeLabel: theme.ThemeLabel || `Theme ${idx + 1}`,
              Definition: theme.Definition || '',
              Keywords: Array.isArray(theme.RepresentativeKeywords)
                ? theme.RepresentativeKeywords.join(', ')
                : (theme.RepresentativeKeywords || ''),
              ParticipantIDs: idsArr.map(v => (v == null ? '' : String(v))).filter(Boolean).join('; ')
            });
          });
        } else {
          longRows.push({
            Question: questionCol,
            ThemeLabel: '_parse_error',
            Definition: 'Raw LLM text was kept internally.',
            Keywords: '',
            ParticipantIDs: ''
          });
        }
      });
      const longCsv = Papa.unparse(longRows);
      const longName = `themes_by_question_${new Date().toISOString().split( 'T')[0]}.csv`;
  
      // ---------- WIDE (binary codes per theme)
      const resolvedIdCol = resolveIdColumn(csvData, idColumn) || 'user_id';
      const allIds = new Set();
      Object.values(results).forEach((themes) => {
        if (Array.isArray(themes)) {
          themes.forEach((t) => {
            const ids = Array.isArray(t.ParticipantID) ? t.ParticipantID : [t.ParticipantID];
            ids.forEach((id) => id != null && id !== '' && allIds.add(String(id)));
          });
        }
      });
  
      const wide = [];
      Array.from(allIds).forEach((participantId) => {
        const rowOut = { [resolvedIdCol]: participantId };
        Object.entries(results).forEach(([questionCol, themes]) => {
          if (Array.isArray(themes)) {
            themes.forEach((theme, idx) => {
              const ids = Array.isArray(theme.ParticipantID) ? theme.ParticipantID : [theme.ParticipantID];
              const themeName = (theme.ThemeLabel || `Theme_${idx + 1}`).toString().replace(/\s+/g, ' ');
              const colName = `${questionCol}_${themeName}`;
              rowOut[colName] = ids.map(String).includes(String(participantId)) ? 1 : 0;
            });
          }
        });
        wide.push(rowOut);
      });
      const wideCsv = Papa.unparse(wide);
      const wideName = `codes_by_question_${new Date().toISOString().split('T')[0]}.csv`;
  
      // ---------- trigger both downloads
      const download = (csvText, filename) => {
        const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
  
      download(longCsv, longName);
      setTimeout(() => download(wideCsv, wideName), 200);
  
      setSuccess('Exported both Long and Wide CSVs!');
    } catch (err) {
      setError('Failed to export results: ' + (err?.message || String(err)));
    }
  };
  

  const clearData = () => {
    setCsvData(null);
    setFileName('');
    setResults(null);
    setError('');
    setSuccess('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /* ===================== NEW: Selective Edit & Reassign (structured ops) ===================== */

  // selected themes to edit per question: { [qcol]: number[] }
  const [selectedEdits, setSelectedEdits] = useState({});

  const toggleThemeSelection = (qcol, idx) => {
    setSelectedEdits((prev) => {
      const next = { ...prev };
      const set = new Set(next[qcol] || []);
      if (set.has(idx)) set.delete(idx); else set.add(idx);
      next[qcol] = Array.from(set);
      return next;
    });
  };

  const selectAllThemesForQuestion = (qcol) => {
    if (!Array.isArray(results?.[qcol])) return;
    const allIdx = results[qcol].map((_, i) => i);
    setSelectedEdits((prev) => ({ ...prev, [qcol]: allIdx }));
  };

  const clearSelectionsForQuestion = (qcol) => {
    setSelectedEdits((prev) => ({ ...prev, [qcol]: [] }));
  };

  // ===== NEW: Structured edit engine (merge/split/replace/delete/insert) =====

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  // Back-compat: your old patch array format (no "op")
  function applyLegacyPatches(arr, patches) {
    const copy = [...arr];
    patches.forEach((p) => {
      const i = Number(p.index);
      if (!Number.isFinite(i) || i < 0 || i >= copy.length) return;
      copy[i] = {
        ThemeLabel: p.ThemeLabel ?? copy[i]?.ThemeLabel ?? `Theme ${i + 1}`,
        Definition: p.Definition ?? copy[i]?.Definition ?? '',
        RepresentativeKeywords: Array.isArray(p.RepresentativeKeywords) ? p.RepresentativeKeywords : (copy[i]?.RepresentativeKeywords || []),
        ParticipantID: Array.isArray(p.ParticipantID) ? p.ParticipantID.map(String) : (copy[i]?.ParticipantID || [])
      };
    });
    return copy;
  }

  function applyStructuredEdits(original, edits) {
    let arr = [...original];
    if (!Array.isArray(edits) || edits.length === 0) return arr;

    // If edits look like legacy patches (no "op"), handle with legacy path
    const looksLegacy = edits.every(e => typeof e === 'object' && !('op' in e));
    if (looksLegacy) return applyLegacyPatches(arr, edits);

    // Defensive copy for op list
    const ops = edits.map(e => ({ ...e }));

    // Helper to build a theme object safely
    const normalizeTheme = (t, fallbackLabel = 'Theme') => ({
      ThemeLabel: t?.ThemeLabel ?? fallbackLabel,
      Definition: t?.Definition ?? '',
      RepresentativeKeywords: Array.isArray(t?.RepresentativeKeywords) ? t.RepresentativeKeywords : [],
      ParticipantID: Array.isArray(t?.ParticipantID) ? t.ParticipantID.map(String) : []
    });

    // Execute in deterministic phases to avoid index-shift headaches.
    // 1) MERGE & SPLIT
    ops.filter(o => o.op === 'merge' || o.op === 'split').forEach(op => {
      if (op.op === 'merge') {
        const indices = Array.isArray(op.indices) ? Array.from(new Set(op.indices)).sort((a,b)=>a-b) : [];
        if (indices.length === 0) return;

        const insertIndex = Number.isFinite(op.insertIndex) ? clamp(op.insertIndex, 0, arr.length) : indices[0];
        const merged = normalizeTheme(op, 'Merged Theme');

        // Remove originals (highest→lowest)
        for (let k = indices.length - 1; k >= 0; k--) {
          const idx = indices[k];
          if (idx >= 0 && idx < arr.length) arr.splice(idx, 1);
        }
        // Insert merged theme at desired index
        const ii = clamp(insertIndex, 0, arr.length);
        arr.splice(ii, 0, {
          ThemeLabel: merged.ThemeLabel,
          Definition: merged.Definition,
          RepresentativeKeywords: merged.RepresentativeKeywords,
          ParticipantID: merged.ParticipantID
        });
      }

      if (op.op === 'split') {
        const idx = Number(op.index);
        if (!Number.isFinite(idx) || idx < 0 || idx >= arr.length) return;

        const replacements = Array.isArray(op.replacements) ? op.replacements.map((t, j) => normalizeTheme(t, `Split ${j+1}`)) : [];
        if (replacements.length === 0) return;

        // Remove the original
        arr.splice(idx, 1);

        // Insert replacements at insertIndex (default to original position)
        const insertIndex = Number.isFinite(op.insertIndex) ? clamp(op.insertIndex, 0, arr.length) : idx;
        const toInsert = replacements.map(r => ({
          ThemeLabel: r.ThemeLabel,
          Definition: r.Definition,
          RepresentativeKeywords: r.RepresentativeKeywords,
          ParticipantID: r.ParticipantID
        }));
        arr.splice(insertIndex, 0, ...toInsert);
      }
    });

    // 2) DELETE
    ops.filter(o => o.op === 'delete').forEach(op => {
      const indices = Array.isArray(op.indices) ? Array.from(new Set(op.indices)).sort((a,b)=>b-a) : [];
      indices.forEach(i => {
        if (i >= 0 && i < arr.length) arr.splice(i, 1);
      });
    });

    // 3) REPLACE
    ops.filter(o => o.op === 'replace').forEach(op => {
      const i = Number(op.index);
      if (!Number.isFinite(i) || i < 0 || i >= arr.length) return;
      const t = normalizeTheme(op.theme, `Theme ${i+1}`);
      arr[i] = {
        ThemeLabel: t.ThemeLabel,
        Definition: t.Definition,
        RepresentativeKeywords: t.RepresentativeKeywords,
        ParticipantID: t.ParticipantID
      };
    });

    // 4) INSERT
    ops.filter(o => o.op === 'insert').forEach(op => {
      const i = Number(op.index);
      if (!Number.isFinite(i)) return;
      const idx = clamp(i, 0, arr.length);
      const t = normalizeTheme(op.theme, `Theme ${idx+1}`);
      arr.splice(idx, 0, {
        ThemeLabel: t.ThemeLabel,
        Definition: t.Definition,
        RepresentativeKeywords: t.RepresentativeKeywords,
        ParticipantID: t.ParticipantID
      });
    });

    return arr;
  }

  // Wrapper that updates state for a given question column
  const applyEditPatches = (qcol, patchesOrOps) => {
    setResults((prev) => {
      const next = { ...prev };
      const arr = Array.isArray(next[qcol]) ? [...next[qcol]] : [];
      const updated = applyStructuredEdits(arr, patchesOrOps);
      next[qcol] = updated;
      return next;
    });
  };

  // ===== Model call for structured edits =====
  async function llmEditThemes({ qcol, selectedIdx, model, idCol, headers }) {
    // safety checks
    const themesArr = Array.isArray(results?.[qcol]) ? results[qcol] : null;
    if (!themesArr) throw new Error('No themes available to edit for the selected question.');
    if (!selectedIdx?.length) throw new Error('No themes selected to edit.');

    // build payload of raw responses for this question (needed to re-evaluate assignments)
    const responsesPayload = buildPayloadForColumn(csvData, idCol, qcol, MAX_INPUT_CHARS, true);

    // Provide current themes and which indices can change
    const currentThemesJson = JSON.stringify(themesArr, null, 2);
    const allowedIndices = JSON.stringify(selectedIdx);

    const schemaAndRules = `
You will return ONLY JSON (no prose).
SCHEMA: an array of operation objects, each with an "op" field, following this spec:

- MERGE: {"op":"merge","indices":[...],"ThemeLabel":"…","Definition":"…","RepresentativeKeywords":["…"],"ParticipantID":["…"],"insertIndex":<optional>}
- SPLIT: {"op":"split","index":i,"replacements":[{theme},{theme},...],"insertIndex":<optional>}
- REPLACE: {"op":"replace","index":i,"theme":{…}}
- DELETE: {"op":"delete","indices":[...]}
- INSERT: {"op":"insert","index":k,"theme":{…}}

HARD RULES:
- Allowed indices (0-based): ${allowedIndices}. Do not modify other indices unless the operation necessarily removes them (merge/split/delete).
- MERGE must output exactly one merged theme for all merged indices and remove the originals.
- SPLIT must remove the original index and insert the replacement themes with full ID assignment.
- For any theme you create or replace, provide complete "ParticipantID" lists (reassign as needed).
- Ensure each ID remains assigned to at least one theme for this question.
- Return strictly valid JSON (array of operation objects only).`;

    const messages = [
      { role: 'system', content: 'You are a precise, compliance-focused data analyst. Output strictly valid JSON with no commentary.' },
      { role: 'user', content:
        `QUESTION COLUMN: ${qcol}
CURRENT THEMES (JSON):
${currentThemesJson}

ALLOWED TO EDIT (0-based indices): ${allowedIndices}

ANALYST REQUEST:
${editPrompt}

${schemaAndRules}

RESPONSES (one per line):
${responsesPayload}`
      }
    ];

    const body = { model, messages };
    const resp = await postChatWithBackoff('https://api.openai.com/v1/chat/completions', body, headers);
    const content = resp.data?.choices?.[0]?.message?.content ?? '[]';
    return content;
  }

  const onEditSelectedForQuestion = async (qcol) => {
    if (!apiKey.trim()) { setError('Please enter your OpenAI API key.'); return; }
    if (!csvData || csvData.length === 0) { setError('Please upload a CSV file first.'); return; }

    const themesArr = Array.isArray(results?.[qcol]) ? results[qcol] : null;
    if (!themesArr) { setError('No themes available to edit for the selected question.'); return; }

    const selectedIdx = (selectedEdits[qcol] || []).slice().sort((a,b)=>a-b);
    if (!selectedIdx.length) { setError('Select at least one theme to edit.'); return; }

    setIsLoading(true); setError(''); setSuccess('');
    try {
      // Resolve ID column reliably
      let resolvedIdCol = resolveIdColumn(csvData, idColumn || 'respid');
      if (!csvData[0] || !(resolvedIdCol in csvData[0])) {
        const autoId = detectIdColumn(csvData);
        if (autoId && autoId in csvData[0]) { resolvedIdCol = autoId; setIdColumn(autoId); }
        else throw new Error('ID column could not be resolved for editing.');
      }

      const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      const model = modelName;

      const content = await llmEditThemes({ qcol, selectedIdx, model, idCol: resolvedIdCol, headers });

      let ops = [];
      try { ops = parseJsonMaybe(content); } catch { throw new Error('The model did not return valid JSON for structured edits.'); }
      if (!Array.isArray(ops)) throw new Error('Edits must be a JSON array.');

      // apply
      applyEditPatches(qcol, ops);
      setSuccess(`Applied ${ops.length} edit operation(s) to ${qcol}.`);
    } catch (err) {
      console.error(err);
      const msg = err?.response?.data?.error?.message || err.message || String(err);
      setError(`Edit failed: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  };

  /* ===================== UI ===================== */

  return (
    <div className="container">
      {/* Header / Logo (acts as reset button) */}
      <div className="header" style={{ display: 'flex', justifyContent: 'center', padding: '8px 0', marginBottom: '8px' }}>
        <button
          className="logo-button"
          onClick={handleLogoClick}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleLogoClick(e)}
          aria-label="Reset app"
          title="Click to reset (Shift/Alt + Click for hard reset)"
          style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer', lineHeight: 0 }}
        >
          <img
            src={logoUrl}
            alt="American Viewpoint"
            className="logo-img"
            style={{ height: 150, width: 'auto', maxWidth: '90vw', display: 'block' }}
          />
        </button>
      </div>

      {/* Two-column layout */}
      <div className="layout">
        {/* LEFT: API key + Upload */}
        <aside className="sidebar">
          {/* API Key */}
          <div className="card">
            <h2>
              <img
                src={logoGif}
                alt="American Viewpoint"
                style={{ width: 20, height: 20, objectFit: 'contain', marginRight: 8, verticalAlign: 'middle' }}
              />{' '}
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
                placeholder="Enter your OpenAI API key"
              />
            </div>
          </div>

          {/* Upload */}
          <div className="card">
            <h2><Upload size={20} /> Upload CSV File</h2>
            <div className="form-group">
              <div
                className={`file-upload ${isDragging ? 'dragover' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileText size={48} style={{ marginBottom: '1rem', color: '#00457f' }} />
                <p>Drag and drop your CSV file here, or click to browse</p>
                <p style={{ fontSize: '0.875rem', color: '#718096', marginTop: '0.5rem' }}>
                  {fileName || 'No file selected'}
                </p>
              </div>
              {/* FIX: proper handler + accept types */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileInputChange}
                style={{ display: 'none' }}
              />
            </div>

            {csvData && (
              <div className="form-group">
                <p><strong>Loaded:</strong> {csvData.length} rows</p>
                {(() => {
                  const questionCols = detectQuestionColumns(csvData);
                  return questionCols.length > 0 ? (
                    <p style={{ color: '#2f855a', fontSize: '0.875rem', marginTop: '0.5rem' }}>
                      ✅ Detected question columns: {questionCols.join(', ')}
                    </p>
                  ) : (
                    <p style={{ color: '#e53e3e', fontSize: '0.875rem', marginTop: '0.5rem' }}>
                      ⚠️ No question columns found (Q1, Q2, Q24, etc.). Please check your CSV format.
                    </p>
                  );
                })()}

                {csvData.length > 1000 && (
                  <p style={{ color: '#e53e3e', fontSize: '0.875rem', marginTop: '0.5rem' }}>
                    ⚠️ Very large dataset: consider filtering to a specific question or sampling to avoid rate/size limits.
                  </p>
                )}

                <div className="actions">
                  <button
                    className="btn btn-secondary"
                    onClick={() => setShowPreview(!showPreview)}
                    style={{ marginRight: '0.5rem' }}
                  >
                    {showPreview ? 'Hide' : 'Show'} Preview
                  </button>
                  <button className="btn btn-secondary" onClick={clearData}>
                    Clear Data
                  </button>
                </div>

                {showPreview && (
                  <div style={{ marginTop: '1rem', padding: '1rem', background: '#f7fafc', borderRadius: '8px' }}>
                    <h4 style={{ marginBottom: '0.5rem' }}>Data Preview (First 5 rows):</h4>
                    <div style={{ maxHeight: '200px', overflow: 'auto', fontSize: '0.875rem' }}>
                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                        {Papa.unparse(csvData.slice(0, 5))}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* RIGHT: Analyze + Messages + Results */}
        <main className="main">
          {/* Analyze (ALWAYS VISIBLE) */}
          <div className="card">
            <h2>
              <img
                src={logoGif}
                alt="American Viewpoint"
                style={{ width: 20, height: 20, objectFit: 'contain', marginRight: 8, verticalAlign: 'middle' }}
              />{' '}
              Analyze Data
            </h2>

            <div className="form-group">
              <label htmlFor="modelSelect">Model</label>
              <select
                id="modelSelect"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                style={{ width: 260, padding: '6px 8px', borderRadius: 6 }}
              >
                <option value="gpt-5">GPT-5 (Best quality)</option>
                <option value="gpt-5-mini">GPT-5 mini (Faster)</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="idColumn">ID Column Name</label>
              <input
                type="text"
                id="idColumn"
                value={idColumn}
                onChange={(e) => setIdColumn(e.target.value)}
                placeholder="e.g., respid, record, participant_id"
                style={{ width: '240px' }}
              />
            </div>

            <div className="form-group qfilter">
              <label htmlFor="questionId">Question Filter (optional)</label>
              <div className="qfilter-row">
                <input
                  type="text"
                  id="questionId"
                  value={questionId}
                  onChange={(e) => setQuestionId(e.target.value)}
                  placeholder="e.g., q24"
                />
              </div>
            </div>

            {/* Analysis Prompt (editable, with reset) */}
            <div className="form-group">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label>Analysis Prompt</label>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={resetPromptToDefault}
                  style={{ padding: '0.4rem 0.75rem', fontSize: '0.9rem' }}
                  title="Reset to the original default prompt"
                >
                  Reset to Default
                </button>
              </div>

              <textarea
                value={analysisPrompt}
                onChange={(e) => setAnalysisPrompt(e.target.value)}
                rows={6}
                style={{ fontFamily: 'monospace', fontSize: '0.875rem', width: '100%' }}
              />

              <div style={{ fontSize: '0.8rem', color: '#718096', marginTop: 6 }}>
                Tip: Keep this concise to reduce tokens; changes are saved automatically.
              </div>
            </div>

            {/* (Edit Prompt lives in the Themes card after results) */}

            <div className="actions" style={{ marginTop: 12 }}>
              <button className="btn" onClick={analyzeData} disabled={isLoading}>
                {isLoading ? (<><div className="spinner"></div>Analyzing…</>) : (<>Analyze</>)}
              </button>
              <button className="btn btn-secondary" onClick={exportBothCSVs} disabled={!results || isLoading}>
                <Download size={16} /> Export CSVs
              </button>
            </div>
          </div>

          {error && (
            <div className="error">
              <AlertCircle size={20} style={{ marginRight: '0.5rem' }} />
              {error}
            </div>
          )}
          {success && (
            <div className="success">
              <CheckCircle size={20} style={{ marginRight: '0.5rem' }} />
              {success}
            </div>
          )}

          {/* Results */}
          {results && (
            <div className="card">
              <h2>Themes</h2>

              {/* Edit Prompt inside the Themes card (visible only when results exist) */}
              <div className="form-group" style={{ marginTop: 8, marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <label>Edit Prompt (applies to selected themes below)</label>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={resetEditPrompt}
                    style={{ padding: '0.4rem 0.75rem', fontSize: '0.9rem' }}
                    title="Reset to the default edit prompt"
                  >
                    Reset Edit Prompt
                  </button>
                </div>
                <textarea
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  rows={5}
                  style={{ fontFamily: 'monospace', fontSize: '0.875rem', width: '100%' }}
                  placeholder="Describe edits, e.g.: merge 0 & 1 into 'Affordability & Cost'; split 2 into 'Availability' and 'Quality' with proper ID reassignment."
                />
              </div>

              <div className="results">
                {Object.entries(results).map(([qcol, themes]) => {
                  // ---- Percent coverage denominator for this question ----
                  const resolvedIdCol = resolveIdColumn(csvData, idColumn) || 'respid';

                  // Universe = all unique IDs with a meaningful response to this question
                  const universe = computeQuestionUniverse(csvData, resolvedIdCol, qcol, skipBlankCells);

                  // Fallback: if universe is empty, use union of IDs across themes
                  const unionAssigned = new Set();
                  if (Array.isArray(themes)) {
                    themes.forEach((t) => {
                      const arr = Array.isArray(t?.ParticipantID) ? t.ParticipantID : (t?.ParticipantID != null ? [t.ParticipantID] : []);
                      arr.forEach((id) => id != null && String(id) !== '' && unionAssigned.add(String(id)));
                    });
                  }
                  const denom = universe.size > 0 ? universe.size : unionAssigned.size;
                  const safeDenom = denom > 0 ? denom : 1; // avoid divide-by-zero; shows 0/1 → 0%

                  return (
                    <div key={qcol} className="theme-item" style={{ borderBottom: '1px solid rgba(0,0,0,0.06)', paddingBottom: 12, marginBottom: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <h3 style={{ marginRight: 12 }}>{qcol}</h3>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="btn btn-secondary" onClick={() => selectAllThemesForQuestion(qcol)} disabled={!Array.isArray(themes)}>
                            Select all
                          </button>
                          <button className="btn btn-secondary" onClick={() => clearSelectionsForQuestion(qcol)}>
                            Clear selection
                          </button>
                          <button
                            className="btn"
                            onClick={() => onEditSelectedForQuestion(qcol)}
                            disabled={isLoading || !(selectedEdits[qcol]?.length)}
                            title="Reevaluate only the selected themes for this question"
                          >
                            {isLoading ? 'Working…' : 'Reevaluate selected themes'}
                          </button>
                        </div>
                      </div>

                      {Array.isArray(themes) ? (
                        themes.map((t, i) => {
                          const idsArr = Array.isArray(t.ParticipantID)
                            ? t.ParticipantID
                            : (t.ParticipantID != null ? [t.ParticipantID] : []);
                          const themeCount = new Set(idsArr.map((v) => String(v))).size;
                          const pct = Math.round((themeCount / safeDenom) * 1000) / 10; // one decimal

                          return (
                            <div key={i} style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 8, background: '#f9fafb' }}>
                              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                                <input
                                  type="checkbox"
                                  checked={(selectedEdits[qcol] || []).includes(i)}
                                  onChange={() => toggleThemeSelection(qcol, i)}
                                  aria-label={`Select theme ${i+1} for editing`}
                                  style={{ marginTop: 4 }}
                                />
                                <div style={{ flex: 1 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                    <strong>{t.ThemeLabel || `Theme ${i + 1}`}</strong>
                                    {/* Coverage badge */}
                                    <span
                                      title={`Coverage of respondent universe for ${qcol}`}
                                      style={{
                                        fontSize: '0.75rem',
                                        padding: '2px 6px',
                                        borderRadius: 999,
                                        background: '#edf2f7',
                                        border: '1px solid rgba(0,0,0,0.08)'
                                      }}
                                    >
                                      {pct}% ({themeCount}/{denom})
                                    </span>
                                  </div>

                                  {t.Definition && <p style={{ marginTop: 4 }}>{t.Definition}</p>}
                                  {Array.isArray(t.RepresentativeKeywords) && t.RepresentativeKeywords.length > 0 && (
                                    <div className="keywords" style={{ marginTop: 4 }}>
                                      {t.RepresentativeKeywords.map((k, j) => (
                                        <span className="keyword" key={j}>{k}</span>
                                      ))}
                                    </div>
                                  )}
                                  {idsArr.length > 0 && (
                                    <div className="participants" style={{ marginTop: 4 }}>
                                      IDs: {idsArr.join(', ')}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <pre style={{ whiteSpace: 'pre-wrap' }}>{typeof themes === 'object' ? JSON.stringify(themes, null, 2) : String(themes)}</pre>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
