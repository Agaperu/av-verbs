import React, { useState, useRef, useEffect } from 'react';
import Papa from 'papaparse';
import axios from 'axios';
import { Upload, Download, FileText, Brain, AlertCircle, CheckCircle } from 'lucide-react';

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
const PLACEHOLDERS = new Set([
  '', ' ', 'na', 'n a', 'n/a', 'none', 'no response', 'no comment', 'nil', '.', '-', '--'
]);
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

    // honor toggle:
    // - when ON: drop empties AND placeholders/very short
    // - when OFF: drop only truly empty strings
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
  const [outputFormat, setOutputFormat] = useState('long'); // 'long' or 'wide' (kept for compatibility)
  const [questionId, setQuestionId] = useState(''); // optional filter (e.g., q24)
  const [idColumn, setIdColumn] = useState('respid'); // default like Python
  const [skipBlankCells, setSkipBlankCells] = useState(true); // remove blanks/placeholders
  const fileInputRef = useRef(null);

  const defaultPrompt = `Your role: You are a senior survey research analyst.
Your task: Read the list of open-ended responses to the survey questions in the attached csv and identify the key themes. It is crucial that every ParticipantID goes into at least one theme category for each question. You may include categories for 'Other', 'Don't Know', and 'Refused' if needed.
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

  /* ===================== File handlers ===================== */

  const handleFileUpload = (file) => {
    if (!file || !file.name.endsWith('.csv')) {
      setError('Please upload a valid CSV file.');
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
          `${analysisPrompt}\n\n` +   // <-- use editable prompt here
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
      const longName = `themes_by_question_${new Date().toISOString().split('T')[0]}.csv`;
  
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

  /* ===================== UI ===================== */

  return (
    <div className="container">
      {/* Header / Logo */}
      <div className="header" style={{ display: 'flex', justifyContent: 'center', padding: '8px 0', marginBottom: '8px' }}>
        <div>
          <img
            src="/images/av-logo3.png"
            alt="American Viewpoint"
            style={{ height: 150, width: 'auto', maxWidth: '90vw', display: 'block' }}
          />
        </div>
      </div>

      {/* Two-column layout */}
      <div className="layout">
        {/* LEFT: API key + Upload */}
        <aside className="sidebar">
          {/* API Key */}
          <div className="card">
            <h2><img
            src="/images/av-logo-gif-no_background.gif"
            alt="American Viewpoint"
            style={{ width: 20, height: 20, objectFit: 'contain', marginRight: 8, verticalAlign: 'middle' }}
          /> OpenAI API Configuration</h2>
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
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
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
            <h2><img
            src="/images/av-logo-gif-no_background.gif"
            alt="American Viewpoint"
            style={{ width: 20, height: 20, objectFit: 'contain', marginRight: 8, verticalAlign: 'middle' }} /> Analyze Data</h2>

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
              {csvData && (
                <div style={{ fontSize: '0.8rem', color: '#718096', marginTop: 4 }}>
                  Detected candidate: <code>{detectIdColumn(csvData) || '—'}</code>
                </div>
              )}
            </div>

            <div className="form-group qfilter compact">
              <label htmlFor="questionId">Question Filter (optional)</label>

              <div className="qfilter-row">
                <input
                  type="text"
                  id="questionId"
                  value={questionId}
                  onChange={(e) => setQuestionId(e.target.value)}
                  placeholder="e.g., q24 (matches prefix)"
                />
              </div>

              <div className="qfilter-hint-row">
                {/*<input
                  id="skipBlanks"
                  type="checkbox"
                  checked={skipBlankCells}
                  onChange={(e) => setSkipBlankCells(e.target.checked)}
                />
                <label htmlFor="skipBlanks" className="qfilter-inline">
                  <span>(Uncheck to include placeholder responses. Truly empty cells are always skipped.)</span>
                </label>*/}
              </div>
            </div>

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
                style={{ fontFamily: 'monospace', fontSize: '0.875rem' }}
              />
              <div style={{ fontSize: '0.8rem', color: '#718096', marginTop: 6 }}>
                Tip: Keep this concise to reduce tokens; changes are saved automatically.
              </div>
            </div>

            {!csvData?.length && (
              <div style={{ marginTop: 8, color: '#718096', fontSize: '0.9rem' }}>
                Upload a CSV to enable analysis.
              </div>
            )}

            <div className="actions">
              <button
                className="btn"
                onClick={analyzeData}
                disabled={isLoading || !apiKey.trim() || !csvData?.length}
              >
                {isLoading ? (
                  <>
                    <div className="spinner"></div>
                    Analyzing...
                  </>
                ) : (
                  <>
                    
                    Analyze
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Messages */}
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

          {/* Results (conditional) */}
          {results && Object.keys(results).length > 0 && (
            <div className="card">
              <h2>Analysis Results</h2>
              <div className="actions" style={{ marginBottom: '1rem' }}>
                <button className="btn btn-success" onClick={exportBothCSVs}>
                  <Download size={20} />
                  Export CSVs
                </button>
              </div>

              <div className="results">
                {Object.entries(results).map(([questionCol, themes]) => (
                  <div key={questionCol} className="theme-item">
                    <h3>Question: {questionCol}</h3>
                    {Array.isArray(themes) ? (
                      themes.map((theme, index) => (
                        <div key={index} style={{ marginBottom: '1rem', padding: '1rem', background: '#f8f9fa', borderRadius: '4px' }}>
                          <h4>{theme.ThemeLabel || `Theme ${index + 1}`}</h4>
                          <p><strong>Definition:</strong> {theme.Definition || 'No definition provided'}</p>
                          {theme.RepresentativeKeywords && theme.RepresentativeKeywords.length > 0 && (
                            <div>
                              <strong>Keywords:</strong>
                              <div className="keywords">
                                {theme.RepresentativeKeywords.map((keyword, keyIndex) => (
                                  <span key={keyIndex} className="keyword">{keyword}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {theme.ParticipantID && (
                            <div className="participants">
                              <strong>Participant IDs:</strong>{' '}
                              {Array.isArray(theme.ParticipantID)
                                ? theme.ParticipantID.join(', ')
                                : String(theme.ParticipantID ?? '')}
                            </div>
                          )}
                        </div>
                      ))
                    ) : (
                      <p style={{ color: '#e53e3e' }}>
                        {themes._error ? `Error: ${themes._error}` : 'Parse issue: raw model text was kept internally.'}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
