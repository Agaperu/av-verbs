# Survey Analysis Web App

This React-based web application provides AI-assisted tools for analyzing survey data. It supports two main workflows:

- **Verbatims (Knowledge Bot):** Thematic coding of open-ended survey responses using LLMs.  
- **Memos (Toplines):** Automated topline tables, demographic splits, and memo-style summaries with visualizations.

## Features

### 🔹 Verbatims (App.jsx)
- Upload CSV survey datasets.  
- Auto-detect **ID columns** and **question columns** (`Q1`, `Q24`, etc.).  
- Run **LLM-powered theme extraction**:
  - Each theme includes a label, definition, keywords, and assigned respondent IDs.  
  - Ensures every respondent is categorized.  
- **Selective editing** of themes (merge, split, replace, insert, delete) with a collapsible edit prompt box.  
- Export results in **long** (themes by question) and **wide** (binary coding per respondent) CSV formats.

### 🔹 Memos (ToplinesApp.jsx)
- Generate **frequency tables** and **weighted toplines** for survey questions.  
- Create **demographic splits** (e.g., gender, age group, region).  
- Summarize results into:
  - Executive brief (1 paragraph)  
  - Bullet-point insights (3–5 bullets)  
  - Detailed narrative (2–3 paragraphs)  
- Interactive bar chart visualizations with stable color palettes.  
- Export results to **tidy CSVs**.

### 🔹 Routing & Authentication (RouterApp.jsx)
- **Login screen** with a passphrase gate.  
- Floating **Logout button** (always visible, adjusts to screen size).  
- Routes:
  - `/bot` → Verbatims app (default)  
  - `/toplines` → Memos app  

## Requirements

- **Node.js** (>=16)  
- **Dependencies:**  
  - React, React Router  
  - Axios (API requests)  
  - PapaParse (CSV parsing)  
  - Recharts (data visualization)  
  - lucide-react (icons)

## Usage

- Login using the configured passphrase.
- Upload a CSV of survey data:
   - For Verbatims (`/bot`):
      - Enter your OpenAI API key.
      - Run theme extraction for open-ended responses.
      - Use the edit panel to merge, split, or refine themes.
      - Export as themes_by_question.csv (long) or codes_by_question.csv (wide).

   - For Memos (`/toplines`):
      - Select survey questions to analyze.
      - Choose optional weight and demographic columns.
      - Generate topline tables and visual summaries.
      - Export as tidy CSVs with topline percentages.
- Log out anytime using the floating logout button in the top-right.

## Notes

- API keys are stored in `localStorage` and cleared on reset
- Data is processed locally in the browser (CSV parsing, charting)
- AI calls are sent securely to the OpenAI API