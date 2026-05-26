const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// In dev: store db in project db/ folder. When packaged (portable): store next to the exe.
const dbDir = app.isPackaged
  ? path.join(app.getPath('userData'), 'db')
  : path.join(__dirname, '..', 'db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// Photo uploads directory
const uploadsDir = app.isPackaged
  ? path.join(app.getPath('userData'), 'uploads')
  : path.join(__dirname, '..', 'db', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

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
      CREATE TABLE IF NOT EXISTS tenant_profiles (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        mobile     TEXT DEFAULT '',
        email      TEXT DEFAULT '',
        doc_type   TEXT DEFAULT '',
        photo_path TEXT DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Inactive')),
        notes      TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS tenant_profile_links (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        profile_id INTEGER NOT NULL REFERENCES tenant_profiles(id),
        UNIQUE(tenant_id, profile_id)
      );

      CREATE TABLE IF NOT EXISTS properties (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        address     TEXT DEFAULT '',
        type        TEXT NOT NULL DEFAULT 'rooming' CHECK(type IN ('rooming','whole')),
        notes       TEXT DEFAULT '',
        created_at  TEXT DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS rooms (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        property_id INTEGER REFERENCES properties(id),
        room_number INTEGER NOT NULL,
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
        property_id INTEGER REFERENCES properties(id),
        date        TEXT NOT NULL,
        description TEXT NOT NULL,
        amount      REAL NOT NULL DEFAULT 0,
        category    TEXT DEFAULT 'General',
        notes       TEXT DEFAULT '',
        created_at  TEXT DEFAULT (datetime('now','localtime'))
      );
    `);

    // ─── Migrations (safe to run on existing DBs) ─────────────────────────────────
    try { db.exec("ALTER TABLE tenants ADD COLUMN profile_id INTEGER REFERENCES tenant_profiles(id)"); } catch(e) {}
    try { db.exec("ALTER TABLE bond_payments ADD COLUMN refund_date TEXT"); }     catch(e) { /* already exists */ }
    try { db.exec("ALTER TABLE bond_payments ADD COLUMN refund_amount REAL"); }   catch(e) { /* already exists */ }
    try { db.exec("ALTER TABLE bond_payments ADD COLUMN refund_bank_ref TEXT DEFAULT ''"); } catch(e) { /* already exists */ }
    try { db.exec("ALTER TABLE rooms ADD COLUMN property_id INTEGER REFERENCES properties(id)"); } catch(e) {}
    try { db.exec("ALTER TABLE expenses ADD COLUMN property_id INTEGER REFERENCES properties(id)"); } catch(e) {}

    // Remove UNIQUE constraint on rooms.room_number (needed for multi-property: each
    // property starts rooms at 1). SQLite can't DROP CONSTRAINT, so we recreate the table.
    try {
      const roomsRow = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='rooms'");
      if (roomsRow && roomsRow.sql && roomsRow.sql.includes('UNIQUE')) {
        db.exec("PRAGMA foreign_keys = OFF");
        db.exec(`
          CREATE TABLE rooms_new (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            property_id INTEGER REFERENCES properties(id),
            room_number INTEGER NOT NULL,
            description TEXT DEFAULT ''
          );
          INSERT INTO rooms_new (id, property_id, room_number, description)
            SELECT id, property_id, room_number, description FROM rooms;
          DROP TABLE rooms;
          ALTER TABLE rooms_new RENAME TO rooms;
        `);
        db.exec("PRAGMA foreign_keys = ON");
        console.log('Migrated rooms table: removed UNIQUE constraint on room_number');
      }
    } catch(e) { console.error('rooms unique-constraint migration error:', e); }

    // ─── Seed default property for existing installs ──────────────────────────────
    // If rooms exist but no properties yet, create "My Property" and link all rooms to it
    const propCount = get("SELECT COUNT(*) as c FROM properties");
    const roomCount = get("SELECT COUNT(*) as c FROM rooms");
    if (propCount && propCount.c === 0 && roomCount && roomCount.c > 0) {
      run(`INSERT INTO properties (name, address, type, notes) VALUES ('My Property', '', 'rooming', 'Default property (auto-created)')`);
      run(`UPDATE rooms SET property_id = (SELECT id FROM properties ORDER BY id LIMIT 1) WHERE property_id IS NULL`);
      console.log('Created default property and linked existing rooms');
    }

    // Assign orphaned expenses (property_id IS NULL) to the oldest property.
    // Expenses added before property-scoping was introduced have no property_id.
    try {
      const firstProp = get("SELECT id FROM properties ORDER BY id LIMIT 1");
      if (firstProp) {
        const orphaned = run("UPDATE expenses SET property_id = ? WHERE property_id IS NULL", [firstProp.id]);
        if (orphaned.changes > 0) console.log(`Linked ${orphaned.changes} orphaned expense(s) to property ${firstProp.id}`);
      }
    } catch(e) { console.error('expenses property migration error:', e); }

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

  // Ensure new tables exist (old DBs predate these)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_profiles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      mobile     TEXT DEFAULT '',
      email      TEXT DEFAULT '',
      doc_type   TEXT DEFAULT '',
      photo_path TEXT DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Inactive')),
      notes      TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS tenant_profile_links (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES tenant_profiles(id),
      UNIQUE(tenant_id, profile_id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS properties (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      address     TEXT DEFAULT '',
      type        TEXT NOT NULL DEFAULT 'rooming' CHECK(type IN ('rooming','whole')),
      notes       TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  // Re-run column migrations in case the imported DB predates schema additions
  try { db.exec("ALTER TABLE tenants ADD COLUMN profile_id INTEGER REFERENCES tenant_profiles(id)"); } catch(e) {}
  try { db.exec("ALTER TABLE bond_payments ADD COLUMN refund_date TEXT"); }             catch(e) {}
  try { db.exec("ALTER TABLE bond_payments ADD COLUMN refund_amount REAL"); }           catch(e) {}
  try { db.exec("ALTER TABLE bond_payments ADD COLUMN refund_bank_ref TEXT DEFAULT ''"); } catch(e) {}
  try { db.exec("ALTER TABLE rooms ADD COLUMN property_id INTEGER REFERENCES properties(id)"); } catch(e) {}
  try { db.exec("ALTER TABLE expenses ADD COLUMN property_id INTEGER REFERENCES properties(id)"); } catch(e) {}

  // Remove UNIQUE constraint on rooms.room_number if present
  try {
    const roomsRow = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='rooms'");
    if (roomsRow && roomsRow.sql && roomsRow.sql.includes('UNIQUE')) {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(`
        CREATE TABLE rooms_new (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER REFERENCES properties(id), room_number INTEGER NOT NULL, description TEXT DEFAULT '');
        INSERT INTO rooms_new (id, property_id, room_number, description) SELECT id, property_id, room_number, description FROM rooms;
        DROP TABLE rooms;
        ALTER TABLE rooms_new RENAME TO rooms;
      `);
      db.exec("PRAGMA foreign_keys = ON");
    }
  } catch(e) {}

  // Seed default property if rooms exist but no properties (old DB migration)
  try {
    const propCount = get("SELECT COUNT(*) as c FROM properties");
    const roomCount = get("SELECT COUNT(*) as c FROM rooms");
    if (propCount && propCount.c === 0 && roomCount && roomCount.c > 0) {
      run(`INSERT INTO properties (name, address, type, notes) VALUES ('My Property', '', 'rooming', 'Default property (auto-created)')`);
      run(`UPDATE rooms SET property_id = (SELECT id FROM properties ORDER BY id LIMIT 1) WHERE property_id IS NULL`);
      console.log('Import: created default property and linked existing rooms');
    }
  } catch(e) { console.error('Import: property seed error:', e); }

  // Link orphaned expenses to first property
  try {
    const firstProp = get("SELECT id FROM properties ORDER BY id LIMIT 1");
    if (firstProp) run("UPDATE expenses SET property_id = ? WHERE property_id IS NULL", [firstProp.id]);
  } catch(e) {}

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
  formatCurrency,
  uploadsDir,
};
