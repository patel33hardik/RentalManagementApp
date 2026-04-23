# 🏠 Rental Manager

A desktop app for managing backpacker room rentals — built with Electron, Express.js, and SQLite.

---

## ✅ Prerequisites

Before installing, make sure you have the following:

### 1. Node.js
Download from https://nodejs.org — choose the **LTS version (v20 or v22)**.

> ⚠️ **Node.js v25 is NOT recommended** — it's too new for stable Electron support.
> If you have v25, please install v22 LTS alongside it using [nvm-windows](https://github.com/coreybutler/nvm-windows).

To check your version:
```bash
node -v
```

### 2. Windows Build Tools (for native SQLite module)
Open **PowerShell as Administrator** and run:
```powershell
npm install -g windows-build-tools
```

Or alternatively install **Visual Studio Build Tools** from:
https://visualstudio.microsoft.com/visual-cpp-build-tools/
(Select "Desktop development with C++" workload)

---

## 🚀 Installation & Running

```bash
# Step 1 — Open terminal in the rental-manager folder, then:
npm install

# Step 2 — Start the app
npm start
```

`npm install` will automatically:
- Install all dependencies (Express, EJS, Electron, etc.)
- Compile `better-sqlite3` for your version of Electron (`postinstall` script)
- Create the SQLite database and seed it with your 4 tenants on first launch

---

## 🔧 Troubleshooting

### Error: `Cannot find module 'electron/cli.js'`
Electron didn't install correctly. Fix:
```bash
npm install --save-dev electron@33
npm start
```

### Error: `Could not locate the bindings file` (better-sqlite3)
The native module needs rebuilding. Fix:
```bash
npm install -g electron-rebuild
npx electron-rebuild -f -w better-sqlite3
npm start
```

### Error: `gyp ERR! not ok` during npm install
You're missing Windows Build Tools. Run in PowerShell (as Admin):
```powershell
npm install -g windows-build-tools
```
Then run `npm install` again.

### App opens but shows blank page
Make sure port 3000 is free. Kill anything using it:
```bash
netstat -ano | findstr :3000
taskkill /PID <PID_NUMBER> /F
```
Then `npm start` again.

---

## 📁 Project Structure

```
rental-manager/
├── main.js                  # Electron entry — launches window + Express
├── package.json
├── db/
│   └── rental_manager.db    # SQLite DB (auto-created on first run)
├── backend/
│   ├── backend.js           # All API routes: /api/rooms /api/tenants /api/ledger etc.
│   └── common.js            # DB connection, schema creation, seed data
├── common/                  # Third-party assets (offline)
│   ├── css/                 # Bootstrap 5, Bootstrap Icons
│   ├── js/                  # jQuery, Bootstrap JS
│   └── fonts/               # Bootstrap Icons webfont
└── frontend/
    ├── frontend.js          # Express page routes (GET /)
    ├── static/
    │   ├── css/app.css      # Custom styles
    │   └── js/app.js        # Shared jQuery helpers
    └── templates/           # EJS page templates
        ├── dashboard.ejs
        ├── rooms.ejs
        ├── tenant.ejs
        ├── add_tenant.ejs
        ├── bond.ejs
        └── expenses.ejs
```

---

## 📋 Features (Phase 1)

| Page | Features |
|------|----------|
| Dashboard | Income, Expenses, Net Profit, Bond summary. Room status. Recent activity. |
| Rooms | 4 room cards with current tenant, rent, bond, pending weeks |
| Tenant Ledger | Weekly rows, mark as paid, edit amounts & references, add weeks |
| Add/Edit Tenant | Form to onboard new tenant — auto-generates 12 weeks of ledger |
| Bond Manager | Record bond collected/refunded per tenant |
| Expenses | Add/edit/delete expenses by category |

---

## 📦 Building to .exe (Phase 7)

Once the app is working:
```bash
npm run build
```
Output will be in the `dist/` folder as a Windows installer `.exe`.
