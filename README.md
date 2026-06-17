# Crypto Transaction Reconciliation Engine

A backend system that ingests cryptocurrency transaction data from two CSV sources (user-reported and exchange-reported), normalizes and validates every row, runs a tolerance-based matching engine to reconcile them, and produces a detailed discrepancy report.

---

## Important Links
- **Explaination Video:** https://drive.google.com/file/d/1bvNWMvywCcHg0RV-xX29-2AE7Dpfwhnp/view?usp=drive_link
- **Resume:** https://drive.google.com/file/d/1cDE1uXzG3QUnTiCcYFgFjPlOSHAeQgVs/view?usp=drive_link
--- 

## Table of Contents

- [Problem Statement](#problem-statement)
- [Why This Exists](#why-this-exists)
- [System Architecture](#system-architecture)
- [Request & Data Flow](#request--data-flow)
- [Ingestion Pipeline](#ingestion-pipeline)
- [Matching Engine](#matching-engine)
- [Database Schema & Indexing](#database-schema--indexing)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Engineering Decisions](#engineering-decisions)
- [Edge Cases Handled](#edge-cases-handled)
- [Setup & Local Development](#setup--local-development)
- [Environment Variables](#environment-variables)
- [Tradeoffs](#tradeoffs)
- [Production Improvements](#production-improvements)
- [Limitations](#limitations)

---

## Problem Statement

Crypto platforms record the same transaction on two sides — the user's ledger and the exchange's ledger. These records **almost never match exactly**. Timestamps drift by seconds. Quantities differ by fractions of a percent. Asset names come in as `"bitcoin"`, `"BTC"`, or `"XBT"` depending on the source. Transaction types show up as `"DEPOSIT"` on one side and `"TRANSFER_IN"` on the other.

The job of this engine is to take both CSVs, clean them into a comparable format, figure out which rows refer to the same real-world transaction, and generate a report that categorizes every record into one of five buckets:

| Category | Meaning |
|---|---|
| `EXACT_MATCH` | Found on both sides. Quantity, price, and fee all within tolerance. |
| `MATCHED` | Found on both sides. Core fields match but minor price/fee differences exist. |
| `CONFLICTING` | Probable match — type and timestamp align, but quantity exceeds tolerance. |
| `UNMATCHED_USER` | Present in user file only. No corresponding exchange record found. |
| `UNMATCHED_EXCHANGE` | Present in exchange file only. No corresponding user record found. |

---

## Why This Exists

In any financial reconciliation system, you can't just do `row1 === row2`. Real-world data is messy:

- **Timestamps drift** — exchange records a BTC buy 32 seconds after the user's system does
- **Quantities differ** — exchange records `0.3001 BTC`, user records `0.3 BTC`
- **Names vary** — user sends `"bitcoin"`, exchange sends `"BTC"`
- **Types are labeled differently** — user says `"TRANSFER_OUT"`, exchange says `"TRANSFER_IN"` (same event, opposite perspectives)
- **Data has errors** — negative quantities, missing timestamps, partial dates, duplicate rows

This engine handles all of that. It doesn't just match — it cleans, validates, normalizes, matches with configurable tolerances, and produces an auditable report with full conflict details.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         POST /reconcile                             │
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐│
│  │  CSV Parser   │──▶│  Validator   │──▶│      Normalizer          ││
│  │  (streaming)  │   │  (per-row)   │   │  (type/asset/ts/qty)     ││
│  └──────────────┘   └──────────────┘   └──────────────────────────┘│
│         │                                         │                 │
│         │              Batch Insert (500)          │                 │
│         ▼─────────────────────────────────────────▼                 │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │                    MongoDB (Transactions)                 │       │
│  └──────────────────────────────────────────────────────────┘       │
│                              │                                      │
│                              ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │              Matching Engine (bucket-based)                │       │
│  │                                                            │       │
│  │   Time Buckets ──▶ Type Filter ──▶ Timestamp Filter        │       │
│  │       ──▶ Quantity Filter ──▶ Best Candidate Selection     │       │
│  └──────────────────────────────────────────────────────────┘       │
│                              │                                      │
│                              ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │              Report Generator (batch persist)              │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                     │
│  GET /report/:runId/summary    ──▶  JSON summary counts             │
│  GET /report/:runId/unmatched  ──▶  Paginated unmatched entries     │
│  GET /report/:runId            ──▶  Full CSV download (streamed)    │
└─────────────────────────────────────────────────────────────────────┘
```

The system is split into two clearly separated phases:

1. **Ingestion** — parse → validate → normalize → bulk insert. No matching happens here.
2. **Reconciliation** — bucket → filter → match → persist report → update run status.

This separation is intentional. Ingestion is I/O bound (CSV parsing, DB writes). Reconciliation is CPU bound (comparisons, scoring). Different bottlenecks, clean boundary.

---

## Request & Data Flow

Here's what happens end-to-end when you hit `POST /reconcile`:

```
1. Client sends POST /reconcile
   └── optional body: { timestampToleranceSecs, quantityTolerancePct }

2. Server generates a UUID v4 runId

3. ReconciliationRun document created with status='running'
   └── config snapshot stored — so results are reproducible

4. Both CSVs ingested in PARALLEL (Promise.all)
   ├── user_transactions.csv   → parseAndIngest('user', runId)
   └── exchange_transactions.csv → parseAndIngest('exchange', runId)

   For each file:
     ├── Stream CSV row by row (never loads full file into memory)
     ├── Check for duplicate transaction IDs within the same file
     ├── validateRow() — checks every field, returns quality flags
     ├── normalizeRow() — converts to canonical format (only if valid)
     ├── Build MongoDB document (raw + normalized + audit trail)
     ├── Collect into batch of 500
     └── Bulk insert batch into MongoDB

5. Matching engine runs
   ├── Load all valid transactions for this runId
   ├── Build time-based buckets (10-minute windows, dual-bucket overlap)
   ├── For each user tx, find best exchange candidate
   │   ├── Filter by type compatibility
   │   ├── Filter by timestamp tolerance
   │   ├── Filter by quantity tolerance
   │   └── Score remaining candidates → pick closest
   ├── Clean up stale conflicts (matched elsewhere in later bucket)
   └── Identify unmatched transactions (after ALL buckets processed)

6. Report generator runs
   ├── Build ReportEntry documents for all categories
   ├── Bulk insert in batches of 500
   └── Update ReconciliationRun: status='complete', summary counts persisted

7. Response returned to client with runId and ingestion summary
```

---

## Ingestion Pipeline

The ingestion pipeline is a three-stage chain: **parse → validate → normalize**. Each stage has a single responsibility and doesn't know about the others' internals.

### Stage 1: CSV Parser (`csvParser.js`)

- Uses `csv-parse` with `for await...of` — properly backpressured streaming
- Never loads the entire file into memory. 100 rows or 10 million rows, memory stays flat.
- Collects documents into batches of 500 and bulk inserts via `insertMany({ ordered: false })`
- `ordered: false` means if one doc in a batch fails, the rest still get inserted
- Tracks duplicate transaction IDs with a `Set` — O(1) lookups per row
- Duplicates are detected **within** each file only. Same ID in both files is valid (same real transaction from two perspectives).

### Stage 2: Validator (`validator.js`)

Every field is checked independently. The validator never throws — it always returns a structured result:

```js
{ isValid: true/false, qualityFlags: {}, flaggedFields: [] }
```

| Field | Checks |
|---|---|
| `transaction_id` | Missing or empty |
| `timestamp` | Missing, partial date-only, unparseable, year outside 2009–current, missing timezone |
| `type` | Missing, contains invalid characters |
| `asset` | Missing, contains non-letter characters |
| `quantity` | Missing, non-numeric, negative, zero |
| `price_usd` | Missing, NaN literal, negative, invalid format |
| `fee` | Non-numeric, negative (null fee is acceptable) |

If any field fails, the entire row is marked `isValid: false`. Invalid rows are still stored (with the raw data intact), but the normalizer is skipped and the matching engine ignores them.

### Stage 3: Normalizer (`normalizer.js`)

Only runs on valid, non-duplicate rows. Trust contract: normalizer assumes the validator has already ensured parsability.

| Field | Normalization |
|---|---|
| `timestamp` | Parsed to JS `Date` object. Non-UTC offsets converted to UTC. Audit trail records original timezone. Timestamps without timezone info → stored as `null` (refuses to guess). |
| `type` | Resolved via alias map: `"DEPOSIT"` → `"TRANSFER_IN"`, `"BOUGHT"` → `"BUY"`, etc. Unknown types → `null`. |
| `asset` | Resolved via alias map: `"bitcoin"` → `"BTC"`, `"ethereum"` → `"ETH"`, etc. Unknown assets → uppercased and stored as-is (future-proofing for new coins). |
| `quantity` | String → Number. |
| `price_usd` | String → Number. Handles `"NaN"` string literal. |
| `fee` | String → Number. Null is acceptable. |

Every change is recorded in `normalizationChanges` with `{ from, to, reason }` — this is the audit trail.

---

## Matching Engine

The matching engine (`matchingEngine.js`) is the core of the system. It uses a **bucket-based approach** instead of brute-force O(n²) comparison.

### Bucketing Strategy

Transactions are grouped into 10-minute time windows, keyed by `asset_timestamp-prefix`. Each transaction is placed into **two adjacent buckets** — its own and the next one. This ensures transactions near bucket boundaries are never missed.

```
Example:
  tx at 09:08 → buckets ["BTC_2024-03-01T09:0", "BTC_2024-03-01T09:1"]
  tx at 09:12 → buckets ["BTC_2024-03-01T09:1", "BTC_2024-03-01T09:2"]
  Both appear in "09:1" bucket → they get compared → matched ✓
```

### Matching Pipeline (per user transaction)

```
Type Filter          → only compare BUY↔BUY, SELL↔SELL, TRANSFER_OUT↔TRANSFER_IN
    ↓
Timestamp Filter     → within configurable tolerance (default: 300 seconds)
    ↓
Quantity Filter      → within configurable tolerance (default: 0.01%)
    ↓
Score & Rank         → pre-computed scores, sorted by [timestamp diff, then quantity diff]
    ↓
Classify             → EXACT_MATCH / MATCHED / CONFLICTING / UNMATCHED
```

### Type Compatibility

Not all type pairs are comparable. The engine understands that `TRANSFER_OUT` from the user's perspective is `TRANSFER_IN` from the exchange's perspective:

```
BUY          ↔ BUY            ✓ same label
SELL         ↔ SELL           ✓ same label
TRANSFER_OUT ↔ TRANSFER_IN   ✓ same event, opposite perspectives
TRANSFER_IN  ↔ TRANSFER_OUT  ✓ same event, opposite perspectives
BUY          ↔ SELL           ✗ incompatible
```

### Winner vs. Conflict

If a candidate passes type + timestamp + quantity checks, it's a **winner**. The engine then checks price and fee (1% tolerance) to decide between `EXACT_MATCH` and `MATCHED`.

If a candidate passes type + timestamp but **fails** quantity, it's a **conflict candidate** — recorded separately as `CONFLICTING` with full delta details.

### Deduplication

Four `Set`s track which transaction IDs have been claimed:

- `matchedUserIds` / `matchedExchangeIds` — clean matches
- `conflictingUserIds` / `conflictingExchangeIds` — conflict entries

This prevents:
- Same exchange tx appearing in multiple conflict entries
- A tx being counted as both "conflicting" and "unmatched"
- Stale conflicts (matched cleanly in a later bucket) polluting the report

---

## Database Schema & Indexing

### `Transaction` Collection

Every CSV row becomes one document. Raw data is always preserved. Normalized data is only present for valid rows.

```
{
  runId:                  String        — groups all rows from one reconciliation run
  source:                 'user' | 'exchange'
  raw:                    { ...exact CSV fields as strings }
  normalized:             { transaction_id, timestamp, type, asset, quantity, price_usd, fee }
  normalizationChanges:   Map<field, { from, to, reason }>
  isValid:                Boolean
  qualityFlags:           Map<field, { issue, rawValue, message }>
  flaggedFields:          [String]      — mirrors qualityFlags keys for MongoDB queryability
}
```

**Why `flaggedFields` exists alongside `qualityFlags`:** MongoDB can't efficiently query on dynamic Map keys, but it **can** index and query array values. `flaggedFields: ['timestamp', 'quantity']` lets you do `{ flaggedFields: 'timestamp' }` with an index hit. This is a common MongoDB pattern when you need both structured detail and fast filtering.

### Indexes on `Transaction`

| Index | Purpose |
|---|---|
| `{ runId: 1 }` | Fetch all transactions for a run |
| `{ source: 1, runId: 1 }` | Fetch user-only or exchange-only rows |
| `{ 'normalized.asset': 1, 'normalized.timestamp': 1 }` | Matching engine queries by asset + time window |
| `{ isValid: 1, runId: 1 }` | Load only valid rows for matching |
| `{ flaggedFields: 1 }` | Find all rows with a specific field flagged |

### `ReconciliationRun` Collection

One document per `POST /reconcile` call. Tracks lifecycle and stores the final summary.

```
{
  runId:        String (UUID v4, unique)
  config:       { timestampToleranceSecs, quantityTolerancePct }
  status:       'pending' | 'running' | 'complete' | 'failed'
  summary:      { exactMatch, matched, conflicting, unmatchedUser, unmatchedExchange, totalUser, totalExchange, invalidRows }
  errorMessage: String | null
  createdAt:    Date
  completedAt:  Date | null
}
```

Config is stored per-run so results are **reproducible** — you can always check what tolerances produced a given report.

### `ReportEntry` Collection

One document per result from the matching engine.

```
{
  runId:      String
  category:   'EXACT_MATCH' | 'MATCHED' | 'CONFLICTING' | 'UNMATCHED_USER' | 'UNMATCHED_EXCHANGE'
  reason:     String     — human-readable explanation
  userTx:     Mixed      — full transaction document from user side
  exchangeTx: Mixed      — full transaction document from exchange side
  conflicts:  [{ field, userValue, exchangeValue, difference, differencePercent, reason }]
}
```

Indexes: `{ runId: 1 }` for full report, `{ runId: 1, category: 1 }` for filtered queries (e.g., fetch only unmatched).

---

## API Reference

### `POST /reconcile`

Triggers a full reconciliation run. Ingests both CSVs, runs matching engine, generates report.

**Request Body** (optional):

```json
{
  "timestampToleranceSecs": 300,
  "quantityTolerancePct": 0.01
}
```

If omitted, defaults from `.env` are used.

**Response** `200 OK`:

```json
{
  "success": true,
  "runId": "087759df-78c4-448e-96ec-40b66a3e16a7",
  "message": "Reconciliation completed!",
  "ingestionSummary": {
    "user": { "total": 25, "valid": 21, "invalid": 4 },
    "exchange": { "total": 25, "valid": 25, "invalid": 0 }
  }
}
```

---

### `GET /report/:runId/summary`

Returns aggregated counts. Single document lookup — no aggregation needed because counts are pre-stored.

**Response** `200 OK`:

```json
{
  "success": true,
  "runId": "087759df-...",
  "status": "complete",
  "summary": {
    "exactMatch": 17,
    "matched": 1,
    "conflicting": 1,
    "unmatchedUser": 0,
    "unmatchedExchange": 3,
    "total": 22
  }
}
```

---

### `GET /report/:runId/unmatched`

Returns unmatched transactions with pagination.

**Query Params:**

| Param | Default | Description |
|---|---|---|
| `source` | both | `user` or `exchange` — filter by side |
| `page` | 1 | Page number |
| `limit` | 50 | Rows per page (max 200) |

---

### `GET /report/:runId`

Streams the full report as a CSV download. Processes in batches of 500 — memory stays flat regardless of report size. Categories are ordered: EXACT_MATCH → MATCHED → CONFLICTING → UNMATCHED_USER → UNMATCHED_EXCHANGE.

---

## Project Structure

```
├── src/
│   ├── app.js                          # Express setup, route registration, server start
│   ├── config/
│   │   ├── db.js                       # MongoDB connection + index creation on startup
│   │   ├── logger.js                   # Winston logger with daily rotation + error separation
│   │   ├── constants.js                # Canonical types, type aliases, asset aliases (single source of truth)
│   │   └── tolerances.js               # Default matching tolerances from .env
│   ├── models/
│   │   ├── Transaction.js              # Schema for ingested CSV rows (raw + normalized + flags)
│   │   ├── ReconciliationRun.js        # Schema for run lifecycle tracking
│   │   └── ReportEntry.js             # Schema for matching results (5 categories)
│   ├── routes/
│   │   ├── reconcile.js                # POST /reconcile — orchestrates ingestion + matching
│   │   └── report.js                   # GET /report/:runId — summary, unmatched, CSV download
│   └── services/
│       ├── ingestion/
│       │   ├── csvParser.js            # Streaming CSV parser with batch inserts
│       │   ├── validator.js            # Per-row field validation (7 fields, 15+ checks)
│       │   └── normalizer.js           # Type/asset/timestamp/quantity normalization
│       └── reconciliation/
│           ├── matchingEngine.js       # Bucket-based matching with tolerance checks
│           ├── reportGenerator.js      # Persists results + updates run status
│           └── csvReportBuilder.js     # Flattens nested documents for CSV export
├── uploads/                            # CSV files to reconcile (gitignored)
├── logs/                               # Winston log files (gitignored, daily rotation)
├── .env                                # Environment configuration (gitignored)
├── .gitignore
└── package.json
```

---

## Engineering Decisions

### Why `for await...of` instead of `stream.on('data')`

The old `stream.on('data', async callback)` pattern has a well-known bug: the stream doesn't wait for async callbacks to complete before emitting the next chunk. This means if your batch insert takes 50ms but the stream emits every 5ms, you get race conditions, duplicate inserts, and corrupted counts.

`for await...of` properly pauses the stream until each iteration completes. It's the correct pattern for async processing of Node streams.

### Why batch is cleared BEFORE `insertMany`

```js
const toInsert = [...batch]
batch.length = 0        // clear BEFORE insert

await Transaction.insertMany(toInsert, { ordered: false })
```

If the batch is cleared **after** the insert and something goes wrong (timeout, retry), the same batch could be flushed twice. Duplicate data in a reconciliation system is worse than lost data — duplicates silently corrupt results and are hard to detect. Lost data is immediately visible (row counts don't match) and easy to re-ingest.

### Why `Decimal.js` is a dependency but not used everywhere

`Decimal.js` is in `package.json` for future use in financial calculations where floating-point precision matters. Currently, quantities and prices are small enough that IEEE 754 doubles don't cause issues at the tolerance levels we're checking (0.01%). For sub-basis-point precision in production, all arithmetic should go through `Decimal.js`.

### Why `ordered: false` on every `insertMany`

Without it, a single bad document aborts the entire batch. With `ordered: false`, MongoDB inserts every valid document and only reports errors for the failures. In a 500-row batch, losing 1 row is acceptable. Losing 499 because of 1 is not.

### Why tolerances are stored per-run

If you run reconciliation with 300s tolerance on Monday and 120s tolerance on Tuesday, you get different results. Storing the config alongside the run means you can always explain why a particular report looks the way it does. This is critical for auditing.

### Why CSV download is streamed, not built in memory

A reconciliation run could have tens of thousands of report entries. Building the entire CSV string in memory before sending risks OOM. Streaming it row by row with `res.write()` keeps memory constant. The `for` loop processes one category at a time, one batch at a time, one row at a time.

---

## Edge Cases Handled

| Scenario | How it's handled |
|---|---|
| Duplicate transaction IDs within same file | Flagged as `DUPLICATE_ID`, marked invalid, skipped by matching engine |
| Same transaction ID in both files | Allowed — same real transaction from two perspectives |
| Timestamp with no timezone | Marked invalid by validator. Normalizer refuses to assume UTC. |
| Partial timestamps (`"2024-03-09T"`) | Detected and flagged as `PARTIAL_TIMESTAMP` |
| Negative quantities | Flagged as `NEGATIVE_QUANTITY`, row marked invalid |
| Zero quantities | Flagged as `ZERO_QUANTITY`, row marked invalid |
| `"NaN"` string literal in price | Detected and flagged as `MISSING_PRICE` |
| Asset aliases (`"bitcoin"` vs `"BTC"`) | Normalized to canonical symbol via lookup map |
| Type aliases (`"DEPOSIT"` vs `"TRANSFER_IN"`) | Normalized to canonical type via alias map |
| `TRANSFER_OUT` ↔ `TRANSFER_IN` matching | Handled as compatible types in matching engine |
| Transactions near bucket boundaries | Dual-bucket insertion ensures no missed comparisons |
| Multiple exchange candidates for one user tx | Scored and ranked by [timestamp proximity, then quantity proximity] |
| Conflict resolved in later bucket | Stale conflicts cleaned up after all buckets processed |
| Server crash mid-reconciliation | Run status stays `'running'` — never becomes `'complete'` or `'failed'` |
| DB down during error handling | `.catch(() => {})` on the status update prevents double crash |
| CSV with slightly malformed quotes | `relax_quotes: true` in parser config handles it gracefully |
| Fee is null/missing | Acceptable — some exchanges don't report fees. Not flagged. |

---

## Setup & Local Development

### Prerequisites

- **Node.js** 18+ (uses `for await...of`, optional chaining, nullish coalescing)
- **MongoDB** 6+ (running locally or Atlas)

### Installation

```bash
git clone https://github.com/tanishqio/KoinX-Transaction-Engine-Assignment.git
cd KoinX-Transaction-Engine-Assignment
npm install
```

### Environment Configuration

Create a `.env` file in the project root:

```env
PORT=3000
MONGO_URI=mongodb://localhost:27017/reconciliation
TIMESTAMP_TOLERANCE_SECONDS=300
QUANTITY_TOLERANCE_PCT=0.01
```

### Running

```bash
# development (with hot reload)
npm run dev

# production
npm start
```

### Testing a Reconciliation

Place your CSV files in the `uploads/` directory:
- `uploads/user_transactions.csv`
- `uploads/exchange_transactions.csv`

Then:

```bash
# trigger reconciliation
curl -X POST http://localhost:3000/reconcile

# with custom tolerances
curl -X POST http://localhost:3000/reconcile \
  -H "Content-Type: application/json" \
  -d '{"timestampToleranceSecs": 120, "quantityTolerancePct": 0.05}'

# get summary
curl http://localhost:3000/report/<runId>/summary

# get unmatched (paginated)
curl "http://localhost:3000/report/<runId>/unmatched?source=exchange&page=1&limit=20"

# download full CSV report
curl http://localhost:3000/report/<runId> --output report.csv
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `MONGO_URI` | `mongodb://localhost:27017/reconciliation` | MongoDB connection string |
| `TIMESTAMP_TOLERANCE_SECONDS` | `300` | Max seconds apart for two timestamps to still match |
| `QUANTITY_TOLERANCE_PCT` | `0.01` | Max percentage difference for quantities to still match |

All tolerances can also be overridden per-run via the request body on `POST /reconcile`.

---

## Tradeoffs

| Decision | What we gained | What we gave up |
|---|---|---|
| Synchronous request-response (no job queue) | Simpler deployment and debugging. No Redis/RabbitMQ dependency. | Long reconciliation runs block the HTTP response. Not viable for 1M+ row files. |
| File-based CSV input (not upload) | Simpler API surface, no multipart parsing. Focus stays on the engine. | Clients must pre-place files on disk. Not production-ready for a real API. |
| In-memory bucketing | Fast O(n) bucket construction + O(bucket_size²) matching per bucket. Good enough for thousands of rows. | Entire valid transaction set must fit in memory. Won't scale past ~500K rows without cursor-based loading. |
| Single-process Node.js | No concurrency issues, easy to reason about. | CPU-bound matching blocks the event loop. Scaling requires worker threads or a job queue. |
| Storing full transaction documents in ReportEntry | Complete audit trail — report is self-contained. | Storage overhead. In production, store references and join on read. |
| `ordered: false` on every insert | Partial failures don't kill the entire batch. | Lost rows require manual identification from logs. |

---

## Production Improvements

- **File upload endpoint** — accept multipart form data instead of reading from disk
- **Job queue** — move reconciliation to a Bull/BullMQ worker. Return `202 Accepted` with a `runId`, let the client poll `GET /report/:runId/summary` for status
- **Cursor-based loading** — stream transactions from MongoDB instead of `.find().lean()` to handle arbitrarily large datasets
- **Worker threads** — offload the matching engine to a worker thread so it doesn't block the event loop
- **Rate limiting** — prevent abuse on `POST /reconcile`
- **Authentication** — API key or JWT. Currently anyone can trigger a reconciliation
- **Input validation middleware** — validate request body schema with Joi or Zod before hitting the route handler
- **Helmet + CORS** — security headers and origin restrictions
- **Health check endpoint** — `GET /health` returning MongoDB connection status
- **Graceful shutdown** — handle `SIGTERM`, finish in-flight operations before exit
- **Decimal.js everywhere** — use arbitrary-precision arithmetic for all financial calculations
- **Test suite** — unit tests for validator/normalizer, integration tests for the full pipeline, property-based tests for the matching engine
- **Containerization** — Dockerfile + docker-compose with MongoDB
- **Monitoring** — structured JSON logs, request duration metrics, error rate tracking

---

## Limitations

- **No file upload** — CSVs must be placed in `uploads/` manually
- **No authentication** — all endpoints are publicly accessible
- **Synchronous processing** — large files will cause request timeouts
- **Fixed CSV schema** — expects exactly `transaction_id, timestamp, type, asset, quantity, price_usd, fee, note`
- **No test coverage** — no unit or integration tests
- **Single-node only** — matching engine state is in-memory, can't be distributed without redesign

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express 5 |
| Database | MongoDB + Mongoose 9 |
| CSV Parsing | `csv-parse` (streaming) |
| Precision Math | `Decimal.js` |
| Date Handling | `date-fns` + native `Date` |
| Logging | Winston + `winston-daily-rotate-file` |
| IDs | `uuid` v4 |

---

Built by [Tanishq Bhakar](https://github.com/tanishqio)!

---
