const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// Resolve DB path — works both in dev and packaged Electron
const dbDir = path.join(__dirname, '..', 'db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const DB_PATH = path.join(dbDir, 'rental_manager.db');

let SQL = null;
let db = null;
let saveTimer = null;

// ─── Database Helper Functions (sql.js version) ───────────────────────────────

// Execute SQL with no return (for CREATE, INSERT, UPDATE, DELETE)
function exec(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) {
      // Just execute, don't collect results
    }
    stmt.free();
    return { changes: db.getRowsModified() };
  } catch (error) {
    console.error('SQL Error:', error);
    throw error;
  }
}

// Get all rows as array of objects
function all(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  } catch (error) {
    console.error('SQL Error:', error);
    throw error;
  }
}

// Get single row (first result)
function get(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    let result = null;
    if (stmt.step()) {
      result = stmt.getAsObject();
    }
    stmt.free();
    return result;
  } catch (error) {
    console.error('SQL Error:', error);
    throw error;
  }
}

// Run a single statement (insert/update/delete) and return last insert ID
function run(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    stmt.step();
    const changes = db.getRowsModified();
    
    // Get last insert rowid
    let lastId = null;
    const idStmt = db.prepare("SELECT last_insert_rowid() as id");
    if (idStmt.step()) {
      lastId = idStmt.getAsObject().id;
    }
    idStmt.free();
    stmt.free();
    
    return { changes, lastInsertRowid: lastId };
  } catch (error) {
    console.error('SQL Error:', error);
    throw error;
  }
}

// Save database to disk
function saveDatabase() {
  if (db) {
    try {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
      console.log('Database saved to disk');
    } catch (error) {
      console.error('Error saving database:', error);
    }
  }
}

// Initialize database (async)
async function initializeDatabase() {
  try {
    // Load sql.js
    SQL = await initSqlJs();
    
    // Load existing database or create new
    let dbData = null;
    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      dbData = new Uint8Array(fileBuffer);
      console.log('Existing database loaded');
    } else {
      console.log('Creating new database');
    }
    
    // Create database instance
    db = new SQL.Database(dbData);
    
    // Enable foreign keys
    db.exec("PRAGMA foreign_keys = ON");
    
    // ─── Schema ───────────────────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        room_number INTEGER NOT NULL UNIQUE,
        description TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS tenants (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id     INTEGER NOT NULL REFERENCES rooms(id),
        name        TEXT NOT NULL,
        weekly_rent REAL NOT NULL DEFAULT 0,
        bond        REAL NOT NULL DEFAULT 0,
        move_in     TEXT,
        move_out    TEXT,
        status      TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Inactive')),
        notes       TEXT DEFAULT '',
        created_at  TEXT DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS ledger (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
        start_date  TEXT NOT NULL,
        end_date    TEXT NOT NULL,
        amount      REAL,
        bank_ref    TEXT DEFAULT '',
        pay_date    TEXT,
        status      TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','✓ Paid','Waived')),
        notes       TEXT DEFAULT '',
        created_at  TEXT DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS bond_payments (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id       INTEGER NOT NULL REFERENCES tenants(id),
        date            TEXT NOT NULL,
        amount          REAL NOT NULL,
        bank_ref        TEXT DEFAULT '',
        type            TEXT NOT NULL DEFAULT 'Collected' CHECK(type IN ('Collected','Refunded')),
        refund_date     TEXT,
        refund_amount   REAL,
        refund_bank_ref TEXT DEFAULT '',
        notes           TEXT DEFAULT '',
        created_at      TEXT DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS expenses (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        date        TEXT NOT NULL,
        description TEXT NOT NULL,
        amount      REAL NOT NULL DEFAULT 0,
        category    TEXT DEFAULT 'General',
        notes       TEXT DEFAULT '',
        created_at  TEXT DEFAULT (datetime('now','localtime'))
      );
    `);

    // ─── Migrations (safe to run on existing DBs) ─────────────────────────────────
    try { db.exec("ALTER TABLE bond_payments ADD COLUMN refund_date TEXT"); }     catch(e) { /* already exists */ }
    try { db.exec("ALTER TABLE bond_payments ADD COLUMN refund_amount REAL"); }   catch(e) { /* already exists */ }
    try { db.exec("ALTER TABLE bond_payments ADD COLUMN refund_bank_ref TEXT DEFAULT ''"); } catch(e) { /* already exists */ }

    // Set up auto-save every 10 seconds
    if (saveTimer) clearInterval(saveTimer);
    saveTimer = setInterval(saveDatabase, 10000);

    // Save on process exit
    process.on('exit', saveDatabase);
    process.on('SIGINT', () => {
      saveDatabase();
      process.exit();
    });

    console.log('Database initialized successfully');
    return db;

  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  }
}

// Replace the in-memory database with an imported file buffer
function reinitializeDb(buffer) {
  if (saveTimer) clearInterval(saveTimer);
  db = new SQL.Database(new Uint8Array(buffer));
  db.exec("PRAGMA foreign_keys = ON");
  // Re-run migrations in case the imported DB predates schema additions
  try { db.exec("ALTER TABLE bond_payments ADD COLUMN refund_date TEXT"); }             catch(e) {}
  try { db.exec("ALTER TABLE bond_payments ADD COLUMN refund_amount REAL"); }           catch(e) {}
  try { db.exec("ALTER TABLE bond_payments ADD COLUMN refund_bank_ref TEXT DEFAULT ''"); } catch(e) {}
  saveDatabase();
  saveTimer = setInterval(saveDatabase, 10000);
}

// ─── Shared helper: format currency ───────────────────────────────────────────
function formatCurrency(value) {
  return `$${Number(value || 0).toLocaleString('en-AU', { minimumFractionDigits: 2 })}`;
}

// Export all the things
module.exports = {
  initializeDatabase,
  getDb: () => db,
  exec,
  all,
  get,
  run,
  saveDatabase,
  reinitializeDb,
  formatCurrency
};
