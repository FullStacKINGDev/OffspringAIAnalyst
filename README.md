# WACD Financial Assistant (POC)

An AI financial analysis assistant for Offspring and their client WorldACD Market Data B.V. (WACD).
Ask questions in plain English ("Are we on track to hit the annual budget?", "Which expenses are increasing the most?")
and get answers built from the trial balance, P&L, budget and revenue forecast files.

**Design principle: the model never does the arithmetic.** A deterministic Node.js analysis engine computes every figure
(totals, variances, trends, projections, reconciliations). GPT-4.1 decides which analyses to run through tool calls,
then explains the results. Each answer lists the analysis steps and source files behind it.

## Quick start

```bash
npm install
cp .env.example .env        # then set OPENAI_API_KEY
npm start                   # http://localhost:3000
```

| Command | What it does |
| --- | --- |
| `npm start` | Web app on `PORT` (default 3000) |
| `npm run dev` | Same, restarting on code changes |
| `npm run check` | Loads the data and prints coverage, headline figures and all data-quality findings. No AI calls. |
| `npm run ask -- "question"` | Asks the assistant from the terminal |
| `npm run eval` | Accuracy test: benchmark questions through the live AI, checked against figures computed by the engine (a few cents of API use) |
| `npm run test:verify` | Self-test of the three verification layers against known-good and known-wrong answers (add `-- --review` for the live reviewer) |

`.env` settings: `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4.1`), `PORT`, `DATA_DIR` (default `./Data`),
`FY_START_MONTH` (default 4 = April), `MATERIALITY_EUR` (default 50000, the threshold for "material" movements).

## Data

Files are discovered anywhere under `Data/` by name. When there are several candidates, the most recently modified one wins.
So for a new month-end, drop in the new files and click **Reload data**. No restart is needed.

| Source | File name must contain | Used for |
| --- | --- | --- |
| Exact Online trial balance | `TB` | Trial balance, balance sheet, cross-check of the P&L |
| Offspring MBR workbook | `MBR` | Budget (`BUDGET` sheet); MBR report pages (`A to B`, `A to PY`) and `ACTUAL` sheet, used for reconciliation |
| Offspring P&L workfile | `Workfile` | **Primary source of P&L actuals**: account-level monthly P&L (`P&L WACD`); `Budget - Overview` for reconciliation |
| Offspring revenue forecast | `Revenue forecast` | Invoicing forecast of subscription renewals |

Conventions the app applies (and tells the model about):

- **Currency:** EUR.
- **Financial year:** April–March, named after the year it ends. `FY2027` = Apr 2026 – Mar 2027, which Exact calls
  "Financial year 2027". Offspring's files label the same year "FY26" / "FY 26/27".
- **Budget vs forecast:** "Budget" is the MBR `BUDGET` sheet. The "Revenue forecast" is **invoicing**, not P&L revenue:
  subscriptions are billed up front and recognised over their term through deferred income.
- **P&L sign convention:** MBR presentation (income +, costs −), so a positive variance is always favourable.
- **Missing values are never treated as zero.** A month without actuals is reported as missing. Formula cells saved without
  a calculated value are treated as missing. The one exception is a blank amount in a ledger export (the workfile account rows,
  the Exact TB), because those exports leave zero cells blank.

## Architecture

```text
public/                 Chat UI (vanilla JS, no build step): streaming answers with a live "show work" timeline,
                        sidebar tabs (Overview KPIs + trend lines + revenue chart, Checks, Sources), light/dark/system
                        theme, mobile drawer. Geist font and Lucide icons are served locally from node_modules.
                        Motion (count-ups, drawn trend lines, growing bars, streaming caret, theme reveal) lives in
                        the "Motion" section of styles.css; the animated panel background (aurora, cursor-lit dot
                        grid, flowing market-line canvas) in "Background effects" + app.js backgroundFx(). All of it
                        switches off under prefers-reduced-motion, and the canvas pauses when the tab is hidden.
src/server.js           Express: /api/chat (SSE stream), /api/overview, /api/issues, /api/reload
src/state.js            Loads the Data folder once, reload on demand
src/config.js           .env settings
src/lib/                Excel reading (exceljs) and period / fiscal-year helpers
src/data/loaders/       One parser per source workbook (finds headers by label, not fixed cell positions)
src/data/store.js       Builds the normalized model (P&L accounts x months, budget, TB, forecast)
src/data/accountMap.js  Revenue-segment and balance-sheet classification (edit here to remap accounts)
src/analysis/           Deterministic engine:
  pl.js                   P&L statements, variances, drivers, trends, ranked movements
  balance.js              Trial balance flags and balance sheet (derived from the TB)
  forecast.js             Invoicing forecast, recognition estimate, duplicate/overlap checks
  projection.js           Year-end projection (budget / run-rate / prior-year pattern)
  dataQuality.js          Cross-source reconciliation
  overview.js             Sidebar KPIs
src/ai/
  rolePrompt.md           The analyst role prompt (edit freely)
  systemPrompt.js         Role prompt + generated data context (coverage, conventions, known issues)
  tools.js                The 8 tools exposed to the model
  agent.js                OpenAI Chat Completions tool-calling loop, streamed
scripts/                check.js, ask.js
```

### Tools available to the model

| Tool | Purpose |
| --- | --- |
| `pl_statement` | P&L for any period at MBR / section / account level, vs budget, prior year or previous period, with the largest variance drivers |
| `pl_trend` | Monthly / quarterly / yearly series for any line, with budget, YoY, period-over-period changes and highlights |
| `top_movements` | Accounts ranked by change (e.g. fastest-growing expenses) |
| `trial_balance` | TB accounts with automatic flags |
| `balance_sheet` | Opening vs closing balance sheet, key metrics, material movements |
| `revenue_forecast` | Invoicing forecast by month, quarter, customer or currency; revenue-recognition estimate |
| `year_end_projection` | Full-year projection with three labelled methods, compared with budget |
| `data_quality_report` | Reconciliation findings with evidence |

## Data checks

On load, the app reconciles the sources and lists its findings in the sidebar. Click any finding to ask the assistant about it.
Run `npm run check` for the full list. Notable findings in the Aug 2026 data set:

- **Workfile "Budget – Overview":** the "Actual FY 26/27" costs are the *prior-year* costs. The EBIT actuals on that sheet are
  therefore overstated by €229k for Apr–Aug 2026. The MBR "A to B" page is correct.
- **Revenue forecast:** three possible duplicate invoices (€127k: Latam Cargo, Riyadh Air, Air Trade Support). Each has the
  same amount twice, with overlapping subscription periods.
- **MBR "A to PY":** prior-year PY adjustments sit inside "Other Revenue", so Other Revenue shows +1% vs prior year instead of +341%.
- **MBR ACTUAL sheet:** Feb and Mar 2025 are missing.
- **Budget:** two different monthly revenue budget phasings exist, and the "EBIT – Budget" column does not equal revenue minus costs in 4 months.
- **Trial balance:** suspense account 1197 is not cleared (€13.8k credit). Depreciation on computers (4802) is €77 higher in
  Exact than in the workfile.

## Accuracy safeguards

Every figure is calculated by the deterministic engine; the model only chooses which calculations to run and explains the
results. Before an answer is shown, the server holds it back and checks it in three layers:

| Layer | Checks | How |
| --- | --- | --- |
| 1. Figures (`src/ai/verify.js`) | Every amount and percentage exists in the numbers the tools returned for this question, with commercial rounding (25,988.50 must be written 25,989). A calculation written out in the answer is accepted only when both inputs are tool figures and the arithmetic is right. | Code |
| 2. Meaning (`src/ai/meaning.js`) | Each figure sits next to the right item (e.g. General vs Personnel), the right month and the right direction (higher/lower, favourable/adverse). | Code |
| 3. Independent review (`src/ai/review.js`) | A separate reviewer model checks the draft against the raw tool data: right question and period, no unsupported causes, no forecast / budget / invoicing mix-ups, no overclaimed conclusions, material caveats kept. It returns a structured verdict. | AI (`REVIEW_MODEL`, default = `OPENAI_MODEL`) |

The code layers run first; the reviewer runs only on drafts that pass them. A failure at any layer sends the draft back to
the model with the exact problems (up to two correction rounds), and all layers check the rewrite. The answer then shows a
panel: "Verified in 3 layers" with one tick per layer, or an amber warning naming what could not be verified.

Tests:

- `npm run test:verify` feeds the layers known-good answers (must pass: no false alarms) and planted errors taken from real
  failures (must be caught). Layers 1-2 run offline; add `-- --review` to include the live reviewer.
- `npm run eval` asks benchmark questions through the whole live pipeline and compares the answers with figures computed
  directly from the Excel files. Run both after changing prompts, tools or the model, and after loading new month-end files.

Set `REVIEW_ENABLED=false` in `.env` to switch layer 3 off (faster and cheaper, less protection).

What the layers cannot do: they prove every figure is real and correctly attached, and a reviewer confirms the reasoning,
but no automated system can guarantee that a question was interpreted the way the user meant it. Answers therefore always
state their period and basis, and the "Analysis steps" panel shows exactly which calculations were run.

## Limitations

- The balance sheet only covers FY2027 opening vs latest period, because the trial balance has no prior-year comparatives.
- Budget exists only at MBR-category level. Revenue segments use the budget's fixed split.
- Year-end projections are AI projections for discussion, not an official forecast.
- The revenue-recognition estimate spreads forecast invoices straight-line. It excludes the release of existing deferred income.
- The app has no authentication. Run it locally or behind the company's access controls.
