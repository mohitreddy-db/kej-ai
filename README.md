# kejAI Operations Control

Local PostgreSQL-backed operations dashboard for iron-ore inventory, purchases, dispatches, quality, auctions, production, planning and data-quality checks.

The repository does **not** contain KEJ's Excel workbooks or extracted workbook data.

## What is implemented

- PostgreSQL schema and workbook ETL.
- Dashboard pages backed by PostgreSQL.
- Deterministic calculation tools.
- Source workbook, sheet and row provenance.
- Verified, Flagged and Incomplete data states.
- Data-quality checks for balances, ranges, missing links, stale sources and cross-file disagreements.
- A LangGraph ReAct agent that selects approved, read-only business tools.

The language model only understands the question and selects tools. PostgreSQL and deterministic code produce every business number.

## Required input files

Create an `inputs/` folder in the repository root and put these files inside it using the **exact filenames** below:

| File | Sheets used |
|---|---|
| `HO Stock Report (Daily).xlsx` | `LOT MASTER`, `DAILY BOOKS`, `IRON ORE` |
| `Inward Report FY-2026-27 (Daily).xlsx` | `Purchased Details`, `Daily Inward Details`, `Permit Detail's` |
| `Daily Outward Report 2026-27 (Daily).xlsx` | `Outward Details`, `Daily Outward Detail's`, `Permit Detail's` |
| `Inward quality report (Weekly).xlsx` | `Inward Quality Report`, `LOT Details` |
| `Auction Rate Chart FY-2026-27 (Depends On Auction).xlsx` | `Consolidated Data` |
| `All Company Bulk Permit detaisl (Weekly).xlsx` | `Buyer Type` |
| `Auction Bid Sheet Summary (Depends On Auction).xlsx` | `Bid Details`, `Transportation`, `Royalty` |
| `INWARD TRANSPORTER -WORK ORDER FILE-CONTROL SHEET FORMAT.xlsm` | `MASTER `, `INWARD FINAL 26-27` |
| `Fines Planning as on 23-07-2026.xlsx` | `Opening Stock` |
| `Lumps Planning as on 23-07-2026.xlsx` | `Opening Stock` |
| `PRODUCTION REPORT FROM  15-AUG-2025  (Autosaved).xlsx` | `PRODUCTION AND RECOVERY` |

Example:

```text
kej-ai/
├── inputs/
│   ├── HO Stock Report (Daily).xlsx
│   ├── Inward Report FY-2026-27 (Daily).xlsx
│   └── ...the remaining files listed above
├── app/
├── db/
├── lib/
└── scripts/
```

The `inputs/` contents are ignored by Git and must never be committed.

## Run locally

Requirements: Node.js, npm and Docker.

```bash
npm install
npm run db:setup
npm run build
npm start
```

Open <http://localhost:3000>.

`npm run db:setup` starts PostgreSQL 16 on port `54329`, applies `db/schema.sql`, imports the files from `inputs/`, and runs database checks.

To reload updated workbooks:

```bash
npm run refresh
```

## Useful commands

```bash
npm run db:up       # start PostgreSQL
npm run db:migrate  # apply the schema
npm run db:load     # import inputs into PostgreSQL
npm run db:check    # verify the database
npm run check       # run application data/calculation checks
npm run db:down     # stop PostgreSQL
```

The default local database URL is:

```text
postgresql://kejai:kejai_local@127.0.0.1:54329/kejai
```

Set `DATABASE_URL` to use another PostgreSQL database.

## Optional LangGraph agent

The dashboards and calculation tools work without an OpenAI key. To enable the LangGraph ReAct agent, set the key only in your environment:

```bash
export OPENAI_API_KEY="your-key"
export OPENAI_MODEL="gpt-5.6-sol"
```

Never place an API key in source code, the README, a workbook or a committed `.env` file.

The agent currently exposes approved tools for stock quantity/weighted Fe/landed cost, highest daily dispatch, customer month-wise activity, Fe deviation, data-quality status and non-calculating evidence search. Unsupported calculations return Incomplete instead of being improvised by the model.

## Data handling

- Excel files are read only during import.
- PostgreSQL is the runtime source of truth.
- Each normalized record retains its workbook, sheet and row provenance.
- Missing required sources produce Incomplete results.
- Conflicting or suspicious values produce Flagged results with reasons.
- Report sheets, discussions, meeting notes and generated dashboard JSON are not runtime inputs and are intentionally excluded from this repository.
