const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { all, get, run, getDb, reinitializeDb } = require('./common');

const SETTINGS_PATH = path.join(__dirname, '..', 'db', 'settings.json');

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (e) {}
  return {};
}

function writeSettings(obj) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2));
}

const app = express();

// ─── View engine (EJS) ────────────────────────────────────────────────────────
app.set('views', path.join(__dirname, '..', 'frontend', 'templates'));
app.set('view engine', 'ejs');

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve common assets (Bootstrap, jQuery, fonts)
app.use('/common', express.static(path.join(__dirname, '..', 'common')));

// Mount frontend router (page routes + static files)
const frontendRouter = require('../frontend/frontend');
app.use('/', frontendRouter);

// ─── API: Rooms ────────────────────────────────────────────────────────────────

app.get('/api/rooms', (req, res) => {
  try {
    const rooms = all(`
      SELECT r.*, 
        t.id as tenant_id, t.name as tenant_name, t.weekly_rent, t.bond,
        t.move_in, t.move_out, t.status as tenant_status,
        COALESCE(SUM(CASE WHEN l.status = '✓ Paid' THEN l.amount ELSE 0 END), 0) as total_received,
        COUNT(CASE WHEN l.status = 'Pending' THEN 1 END) as pending_weeks
      FROM rooms r
      LEFT JOIN tenants t ON t.room_id = r.id AND t.status = 'Active'
      LEFT JOIN ledger l ON l.tenant_id = t.id
      GROUP BY r.id
      ORDER BY r.room_number
    `);
    res.json({ success: true, data: rooms });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/rooms/:id', (req, res) => {
  try {
    const room = get(`
      SELECT r.*, t.id as tenant_id, t.name as tenant_name, t.weekly_rent,
        t.bond, t.move_in, t.move_out, t.status as tenant_status, t.notes
      FROM rooms r
      LEFT JOIN tenants t ON t.room_id = r.id AND t.status = 'Active'
      WHERE r.id = ?
    `, [req.params.id]);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
    res.json({ success: true, data: room });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/rooms', (req, res) => {
  try {
    const { room_number, description } = req.body;
    if (!room_number) return res.status(400).json({ success: false, error: 'room_number is required' });
    const result = run(`INSERT INTO rooms (room_number, description) VALUES (?, ?)`,
      [room_number, description || '']);
    res.json({ success: true, data: { id: result.lastInsertRowid } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/rooms/:id', (req, res) => {
  try {
    const { room_number, description } = req.body;
    run(`UPDATE rooms SET room_number=?, description=? WHERE id=?`,
      [room_number, description || '', req.params.id]);
    res.json({ success: true, message: 'Room updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/rooms/:id', (req, res) => {
  try {
    const tenant = get(`SELECT id FROM tenants WHERE room_id = ?`, [req.params.id]);
    if (tenant) return res.status(400).json({ success: false, error: 'Cannot delete a room that has tenants. Remove tenants first.' });
    run('DELETE FROM rooms WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Room deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── API: Tenants ──────────────────────────────────────────────────────────────

app.get('/api/tenants', (req, res) => {
  try {
    const { status, room_id } = req.query;
    let query = `
      SELECT t.*, r.room_number,
        COALESCE(SUM(CASE WHEN l.status = '✓ Paid' THEN l.amount ELSE 0 END), 0) as total_received,
        COALESCE(SUM(l.amount), 0) as total_expected,
        COUNT(CASE WHEN l.status = 'Pending' THEN 1 END) as pending_weeks,
        (SELECT bp.date FROM bond_payments bp
         WHERE bp.tenant_id = t.id
         ORDER BY bp.created_at ASC LIMIT 1) as bond_collected_date,
        (SELECT bp.id FROM bond_payments bp
         WHERE bp.tenant_id = t.id
         ORDER BY bp.created_at ASC LIMIT 1) as bond_payment_id,
        (SELECT bp.id FROM bond_payments bp
         WHERE bp.tenant_id = t.id AND bp.refund_date IS NOT NULL
         ORDER BY bp.created_at DESC LIMIT 1) as bond_refund_id,
        (SELECT bp.refund_date FROM bond_payments bp
         WHERE bp.tenant_id = t.id AND bp.refund_date IS NOT NULL
         ORDER BY bp.created_at DESC LIMIT 1) as bond_refund_date
      FROM tenants t
      JOIN rooms r ON r.id = t.room_id
      LEFT JOIN ledger l ON l.tenant_id = t.id
      WHERE 1=1
    `;
    const params = [];
    if (status)  { query += ' AND t.status = ?';  params.push(status); }
    if (room_id) { query += ' AND t.room_id = ?'; params.push(room_id); }
    query += ' GROUP BY t.id ORDER BY t.created_at DESC';

    const tenants = all(query, params);
    res.json({ success: true, data: tenants });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/tenants/:id', (req, res) => {
  try {
    const tenant = get(`
      SELECT t.*, r.room_number,
        COALESCE(SUM(CASE WHEN l.status = '✓ Paid' THEN l.amount ELSE 0 END), 0) as total_received
      FROM tenants t
      JOIN rooms r ON r.id = t.room_id
      LEFT JOIN ledger l ON l.tenant_id = t.id
      WHERE t.id = ?
      GROUP BY t.id
    `, [req.params.id]);
    if (!tenant) return res.status(404).json({ success: false, error: 'Tenant not found' });
    res.json({ success: true, data: tenant });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/tenants', (req, res) => {
  try {
    const { room_id, name, weekly_rent, bond, move_in, move_out, notes, status } = req.body;
    if (!room_id || !name || !weekly_rent) {
      return res.status(400).json({ success: false, error: 'room_id, name and weekly_rent are required' });
    }

    const newStatus = status === 'Inactive' ? 'Inactive' : 'Active';

    // Only displace the existing active tenant when adding a new Active tenant
    if (newStatus === 'Active') {
      run(`UPDATE tenants SET status = 'Inactive', move_out = date('now','localtime') WHERE room_id = ? AND status = 'Active'`, [room_id]);
    }

    const result = run(`
      INSERT INTO tenants (room_id, name, weekly_rent, bond, move_in, move_out, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [room_id, name.trim(), weekly_rent, bond || 0, move_in || null, move_out || null, notes || '', newStatus]);

    // Auto-generate 12 weeks of pending ledger rows starting from move-in date
    const tenantId = result.lastInsertRowid;

    // Parse as local date to avoid UTC midnight shift (new Date('YYYY-MM-DD') = UTC)
    let sy, sm, sd;
    if (move_in) {
      [sy, sm, sd] = move_in.split('-').map(Number);
    } else {
      const now = new Date();
      sy = now.getFullYear(); sm = now.getMonth() + 1; sd = now.getDate();
    }

    function localISO(y, m, d) {
      const dt = new Date(y, m - 1, d);
      return dt.getFullYear() + '-' +
        String(dt.getMonth() + 1).padStart(2, '0') + '-' +
        String(dt.getDate()).padStart(2, '0');
    }

    for (let i = 0; i < 12; i++) {
      const wsISO = localISO(sy, sm, sd + i * 7);
      const weISO = localISO(sy, sm, sd + i * 7 + 6);
      run(`
        INSERT INTO ledger (tenant_id, start_date, end_date, amount, bank_ref, pay_date, status)
        VALUES (?, ?, ?, ?, ?, ?, 'Pending')
      `, [tenantId, wsISO, weISO, null, `Room${room_id} service`, wsISO]);
    }

    res.json({ success: true, data: { id: tenantId }, message: 'Tenant added and ledger created' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/tenants/:id', (req, res) => {
  try {
    const { name, weekly_rent, bond, move_in, move_out, status, notes } = req.body;
    run(`
      UPDATE tenants SET name=?, weekly_rent=?, bond=?, move_in=?, move_out=?, status=?, notes=?
      WHERE id=?
    `, [name, weekly_rent, bond, move_in, move_out, status, notes, req.params.id]);
    res.json({ success: true, message: 'Tenant updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/tenants/:id', (req, res) => {
  try {
    run('DELETE FROM ledger WHERE tenant_id = ?', [req.params.id]);
    run('DELETE FROM bond_payments WHERE tenant_id = ?', [req.params.id]);
    run('DELETE FROM tenants WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Tenant and related records deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── API: Ledger ───────────────────────────────────────────────────────────────

app.get('/api/ledger', (req, res) => {
  try {
    const { tenant_id } = req.query;
    if (tenant_id) {
      const rows = all(`SELECT * FROM ledger WHERE tenant_id = ? ORDER BY start_date ASC`, [tenant_id]);
      return res.json({ success: true, data: rows });
    }
    const rows = all(`
      SELECT l.*, t.name as tenant_name, r.room_number
      FROM ledger l
      JOIN tenants t ON t.id = l.tenant_id
      JOIN rooms r ON r.id = t.room_id
      ORDER BY l.start_date DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ledger', (req, res) => {
  try {
    const { tenant_id, start_date, end_date, amount, bank_ref, pay_date, status, notes } = req.body;
    const result = run(`
      INSERT INTO ledger (tenant_id, start_date, end_date, amount, bank_ref, pay_date, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [tenant_id, start_date, end_date, amount || null, bank_ref || '', pay_date || null, status || 'Pending', notes || '']);
    res.json({ success: true, data: { id: result.lastInsertRowid } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/ledger/:id', (req, res) => {
  try {
    const existing = get('SELECT * FROM ledger WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });
    const b = req.body;
    run(`UPDATE ledger SET tenant_id=?, start_date=?, end_date=?, amount=?, bank_ref=?, pay_date=?, status=?, notes=? WHERE id=?`, [
      b.tenant_id  !== undefined ? b.tenant_id  : existing.tenant_id,
      b.start_date !== undefined ? b.start_date : existing.start_date,
      b.end_date   !== undefined ? b.end_date   : existing.end_date,
      b.amount     !== undefined ? (b.amount || null) : existing.amount,
      b.bank_ref   !== undefined ? b.bank_ref   : existing.bank_ref,
      b.pay_date   !== undefined ? (b.pay_date || null) : existing.pay_date,
      b.status     !== undefined ? b.status     : existing.status,
      b.notes      !== undefined ? b.notes      : existing.notes,
      req.params.id,
    ]);
    res.json({ success: true, message: 'Ledger entry updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/ledger/:id', (req, res) => {
  try {
    run('DELETE FROM ledger WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Ledger entry deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── API: Bond ─────────────────────────────────────────────────────────────────

app.get('/api/bond', (req, res) => {
  try {
    const { tenant_status } = req.query;
    let query = `
      SELECT bp.*, t.name as tenant_name, t.status as tenant_status, r.room_number
      FROM bond_payments bp
      JOIN tenants t ON t.id = bp.tenant_id
      JOIN rooms r ON r.id = t.room_id
      WHERE 1=1
    `;
    const params = [];
    if (tenant_status) { query += ' AND t.status = ?'; params.push(tenant_status); }
    query += ' ORDER BY bp.date DESC';
    const bonds = all(query, params);
    res.json({ success: true, data: bonds });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/bond', (req, res) => {
  try {
    const { tenant_id, date, amount, bank_ref, refund_date, refund_amount, refund_bank_ref, notes } = req.body;
    if (!tenant_id || !date || !amount) return res.status(400).json({ success: false, error: 'tenant_id, date and amount are required' });
    const result = run(`
      INSERT INTO bond_payments (tenant_id, date, amount, bank_ref, refund_date, refund_amount, refund_bank_ref, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [tenant_id, date, amount, bank_ref || '',
        refund_date || null, refund_amount || null, refund_bank_ref || '',
        notes || '']);
    res.json({ success: true, data: { id: result.lastInsertRowid } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/bond/:id', (req, res) => {
  try {
    const existing = get('SELECT * FROM bond_payments WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });
    const b = req.body;
    run(`UPDATE bond_payments SET date=?, amount=?, bank_ref=?, refund_date=?, refund_amount=?, refund_bank_ref=?, notes=? WHERE id=?`, [
      b.date            !== undefined ? b.date            : existing.date,
      b.amount          !== undefined ? (b.amount || null) : existing.amount,
      b.bank_ref        !== undefined ? b.bank_ref        : existing.bank_ref,
      b.refund_date     !== undefined ? (b.refund_date || null) : existing.refund_date,
      b.refund_amount   !== undefined ? (b.refund_amount || null) : existing.refund_amount,
      b.refund_bank_ref !== undefined ? b.refund_bank_ref : existing.refund_bank_ref,
      b.notes           !== undefined ? b.notes           : existing.notes,
      req.params.id,
    ]);
    res.json({ success: true, message: 'Bond payment updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/bond/:id', (req, res) => {
  try {
    run('DELETE FROM bond_payments WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Bond payment deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── API: Expenses ─────────────────────────────────────────────────────────────

app.get('/api/expenses', (req, res) => {
  try {
    const expenses = all('SELECT * FROM expenses ORDER BY date DESC');
    res.json({ success: true, data: expenses });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/expenses', (req, res) => {
  try {
    const { date, description, amount, category, notes } = req.body;
    const result = run(`
      INSERT INTO expenses (date, description, amount, category, notes) VALUES (?, ?, ?, ?, ?)
    `, [date, description, amount, category || 'General', notes || '']);
    res.json({ success: true, data: { id: result.lastInsertRowid } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/expenses/:id', (req, res) => {
  try {
    const { date, description, amount, category, notes } = req.body;
    run(`
      UPDATE expenses SET date=?, description=?, amount=?, category=?, notes=? WHERE id=?
    `, [date, description, amount, category, notes || '', req.params.id]);
    res.json({ success: true, message: 'Expense updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/expenses/:id', (req, res) => {
  try {
    run('DELETE FROM expenses WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Expense deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── API: Dashboard summary ────────────────────────────────────────────────────

app.get('/api/dashboard', (req, res) => {
  try {
    const incomeResult = get(`
      SELECT COALESCE(SUM(amount), 0) as total FROM ledger WHERE status = '✓ Paid'
    `);
    const income = incomeResult ? incomeResult.total : 0;

    const expensesResult = get(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses
    `);
    const expenses = expensesResult ? expensesResult.total : 0;

    const bondResult = get(`
      SELECT
        COALESCE(SUM(amount), 0) as collected,
        COALESCE(SUM(CASE WHEN refund_date IS NOT NULL THEN COALESCE(refund_amount, amount) ELSE 0 END), 0) as refunded
      FROM bond_payments
    `);
    const bond = bondResult || { collected: 0, refunded: 0 };

    const activeRoomsResult = get(`
      SELECT COUNT(*) as c FROM tenants WHERE status = 'Active'
    `);
    const activeRooms = activeRoomsResult ? activeRoomsResult.c : 0;

    const pendingWeeksResult = get(`
      SELECT COUNT(*) as c FROM ledger WHERE status = 'Pending'
    `);
    const pendingWeeks = pendingWeeksResult ? pendingWeeksResult.c : 0;

    const recentLedger = all(`
      SELECT l.*, t.name as tenant_name, r.room_number
      FROM ledger l
      JOIN tenants t ON t.id = l.tenant_id
      JOIN rooms r ON r.id = t.room_id
      ORDER BY l.start_date DESC LIMIT 10
    `);

    res.json({
      success: true,
      data: {
        total_income:   income,
        total_expenses: expenses,
        net_profit:     income - expenses,
        bond_collected: bond.collected,
        bond_refunded:  bond.refunded,
        bond_held:      bond.collected - bond.refunded,
        active_rooms:   activeRooms,
        pending_weeks:  pendingWeeks,
        recent_ledger:  recentLedger,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── API: Settings ────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  res.json({ success: true, data: readSettings() });
});

app.post('/api/settings', (req, res) => {
  try {
    const settings = readSettings();
    Object.assign(settings, req.body);
    writeSettings(settings);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── API: Database Export / Import ────────────────────────────────────────────

app.get('/api/db/export', (req, res) => {
  try {
    const data   = getDb().export();
    const buffer = Buffer.from(data);
    const stamp  = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="rental_manager_${stamp}.db"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/db/export-to-path', (req, res) => {
  try {
    const settings = readSettings();
    const backupDir = settings.backup_path;
    if (!backupDir) return res.status(400).json({ success: false, error: 'No backup folder configured' });
    if (!fs.existsSync(backupDir)) return res.status(400).json({ success: false, error: `Folder not found: ${backupDir}` });

    const stamp    = new Date().toISOString().slice(0, 10);
    const filename = `rental_manager_${stamp}.db`;
    const filePath = path.join(backupDir, filename);

    const data   = getDb().export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(filePath, buffer);

    settings.last_backup      = new Date().toISOString();
    settings.last_backup_file = filename;
    writeSettings(settings);

    res.json({ success: true, message: `Saved to ${filePath}`, file: filename });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/db/import', express.raw({ type: 'application/octet-stream', limit: '100mb' }), (req, res) => {
  try {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ success: false, error: 'No file data received' });
    }
    reinitializeDb(req.body);
    res.json({ success: true, message: 'Database imported successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = app;
