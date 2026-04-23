# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install       # Install deps + rebuild better-sqlite3 for Electron (postinstall)
npm start         # Launch Electron app (production mode)
npm run dev       # Launch with DevTools open (NODE_ENV=development)
npm run build     # Package to Windows .exe installer in dist/
```

There is no test runner or linter configured.

If the app opens a blank page, port 3000 is likely in use. Requires Node.js v20 or v22 LTS — v25 breaks Electron.

## Architecture

This is a **Windows desktop app** (Electron) that embeds a local **Express.js** web server and renders pages in a `BrowserWindow`. There is no browser deployment — the Electron window loads `http://localhost:3000`.

### Boot sequence

`main.js` → starts Express (`backend/backend.js`) on port 3000 → on server ready, opens `BrowserWindow` pointing at `http://localhost:3000`.

### Backend (`backend/`)

- **`backend.js`** — the Express app. Mounts the frontend router, then defines all REST API routes under `/api/`:
  - `GET/POST /api/rooms`, `GET /api/rooms/:id`
  - `GET/POST/PUT /api/tenants`, `GET /api/tenants/:id`
  - `GET/POST/PUT/DELETE /api/ledger`
  - `GET/POST /api/bond`
  - `GET/POST/PUT/DELETE /api/expenses`
  - `GET /api/dashboard` (aggregated summary)

- **`common.js`** — database layer. Uses **sql.js** (WebAssembly SQLite, in-memory). The DB is loaded from `db/rental_manager.db` into RAM on startup, auto-saved to disk every 10 seconds, and saved on process exit. Exports thin wrappers: `exec` (no return), `all` (array of rows), `get` (single row), `run` (INSERT/UPDATE/DELETE, returns `lastInsertRowid`). Schema and seed data live here.

### Frontend (`frontend/`)

- **`frontend.js`** — Express router for page routes (`GET /`, `/rooms`, `/tenant/:id`, `/add-tenant`, `/bond`, `/expenses`). Each route just renders an EJS template with a `title` and `activePage` variable — no server-side data fetching.

- **`templates/`** — EJS page templates. Each page is self-contained HTML that includes three partials: `_sidebar.ejs`, `_topbar.ejs`, `_scripts.ejs`. All data is fetched **client-side** via jQuery AJAX calls to the `/api/*` endpoints after the page loads.

- **`static/js/app.js`** — shared JS helpers loaded on every page: `fmt()` (currency), `fmtDate()` (date), `showToast()` (Bootstrap toast), sidebar toggle, live clock.

- **`static/css/app.css`** — custom styles on top of Bootstrap 5.

### Common assets (`common/thirdparty/`)

Offline copies of third-party libraries, served at `/common/` by Express. No CDN dependency — fully offline.

```
common/thirdparty/
├── bootstrap/
│   ├── css/
│   │   ├── bootstrap.min.css
│   │   ├── bootstrap-icons.min.css
│   │   └── fonts/           ← woff/woff2 (relative path expected by bootstrap-icons.min.css)
│   └── js/
│       └── bootstrap.bundle.min.js
└── jquery/
    └── js/
        └── jquery.min.js
```

### Database schema

Five tables: `rooms`, `tenants`, `ledger`, `bond_payments`, `expenses`. Key relationships:
- Each room has at most one `Active` tenant (adding a new tenant auto-deactivates the previous one).
- `ledger` rows are per-tenant weekly rent periods; status is `Pending`, `✓ Paid`, or `Waived`.
- `bond_payments` tracks `Collected` or `Refunded` bond transactions per tenant.
- Adding a tenant auto-generates 12 weeks of `Pending` ledger rows aligned to Monday.

All DB writes go to the in-memory sql.js instance. Persistence is handled by `saveDatabase()` in `common.js` — writes are NOT immediately durable to disk.
