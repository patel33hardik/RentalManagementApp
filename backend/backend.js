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

// ─── API: Properties ──────────────────────────────────────────────────────────

app.get('/api/properties', (req, res) => {
  try {
    const props = all(`
      SELECT p.*,
        COUNT(DISTINCT r.id) as room_count,
        COUNT(DISTINCT CASE WHEN t.status = 'Active' THEN t.id END) as active_tenants,
        COALESCE(SUM(CASE WHEN l.status = '✓ Paid' THEN l.amount ELSE 0 END), 0) as total_received,
        COUNT(CASE WHEN l.status = 'Pending' THEN 1 END) as pending_weeks
      FROM properties p
      LEFT JOIN rooms r ON r.property_id = p.id
      LEFT JOIN tenants t ON t.room_id = r.id
      LEFT JOIN ledger l ON l.tenant_id = t.id
      GROUP BY p.id
      ORDER BY p.created_at ASC
    `);
    res.json({ success: true, data: props });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/properties/:id', (req, res) => {
  try {
    const prop = get('SELECT * FROM properties WHERE id = ?', [req.params.id]);
    if (!prop) return res.status(404).json({ success: false, error: 'Property not found' });
    res.json({ success: true, data: prop });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/properties', (req, res) => {
  try {
    const { name, address, type, notes, room_count } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });
    const propType = (type === 'whole') ? 'whole' : 'rooming';

    const result = run(
      `INSERT INTO properties (name, address, type, notes) VALUES (?, ?, ?, ?)`,
      [name.trim(), address || '', propType, notes || '']
    );
    const propId = result.lastInsertRowid;

    if (propType === 'rooming') {
      // Create rooms 1..N
      const count = Math.max(1, Math.min(20, parseInt(room_count) || 1));
      for (let i = 1; i <= count; i++) {
        run(`INSERT INTO rooms (property_id, room_number, description) VALUES (?, ?, ?)`,
          [propId, i, '']);
      }
    } else {
      // Whole property — one internal room
      run(`INSERT INTO rooms (property_id, room_number, description) VALUES (?, 1, 'Whole Property')`,
        [propId]);
    }

    res.json({ success: true, data: { id: propId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/properties/:id', (req, res) => {
  try {
    const { name, address, notes, type } = req.body;
    const propId = req.params.id;

    if (type) {
      const existing = get(`SELECT type FROM properties WHERE id=?`, [propId]);
      if (!existing) return res.status(404).json({ success: false, error: 'Property not found' });

      if (type !== existing.type) {
        if (type === 'rooming') {
          // whole → rooming: clear the single room's 'Whole Property' description
          run(`UPDATE rooms SET description='' WHERE property_id=? AND description='Whole Property'`, [propId]);
        } else {
          // rooming → whole: only allowed if exactly 1 room exists
          const roomCount = get(`SELECT COUNT(*) as c FROM rooms WHERE property_id=?`, [propId]);
          if (roomCount && roomCount.c > 1) {
            return res.status(400).json({
              success: false,
              error: `Cannot convert to Whole Property — this property has ${roomCount.c} rooms. Remove extra rooms first.`
            });
          }
          run(`UPDATE rooms SET description='Whole Property' WHERE property_id=?`, [propId]);
        }
      }
    }

    run(`UPDATE properties SET name=?, address=?, notes=?${type ? ', type=?' : ''} WHERE id=?`,
      type
        ? [name, address || '', notes || '', type, propId]
        : [name, address || '', notes || '', propId]
    );
    res.json({ success: true, message: 'Property updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/properties/:id', (req, res) => {
  try {
    const active = get(
      `SELECT t.id FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE r.property_id = ? AND t.status = 'Active' LIMIT 1`,
      [req.params.id]
    );
    if (active) return res.status(400).json({ success: false, error: 'Cannot delete a property with active tenants.' });
    const rooms = all('SELECT id FROM rooms WHERE property_id = ?', [req.params.id]);
    for (const room of rooms) {
      run('DELETE FROM ledger WHERE tenant_id IN (SELECT id FROM tenants WHERE room_id = ?)', [room.id]);
      run('DELETE FROM bond_payments WHERE tenant_id IN (SELECT id FROM tenants WHERE room_id = ?)', [room.id]);
      run('DELETE FROM tenants WHERE room_id = ?', [room.id]);
    }
    run('DELETE FROM rooms WHERE property_id = ?', [req.params.id]);
    run('DELETE FROM expenses WHERE property_id = ?', [req.params.id]);
    run('DELETE FROM properties WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Property deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── API: Rooms ────────────────────────────────────────────────────────────────

app.get('/api/rooms', (req, res) => {
  try {
    const { property_id } = req.query;
    let where = '';
    const params = [];
    if (property_id) { where = 'WHERE r.property_id = ?'; params.push(property_id); }

    const rooms = all(`
      SELECT r.*,
        p.name as property_name, p.type as property_type,
        t.id as tenant_id, t.name as tenant_name, t.weekly_rent, t.bond,
        t.move_in, t.move_out, t.status as tenant_status,
        COALESCE(SUM(CASE WHEN l.status = '✓ Paid' THEN l.amount ELSE 0 END), 0) as total_received,
        COUNT(CASE WHEN l.status = 'Pending' THEN 1 END) as pending_weeks
      FROM rooms r
      LEFT JOIN properties p ON p.id = r.property_id
      LEFT JOIN tenants t ON t.room_id = r.id AND t.status = 'Active'
      LEFT JOIN ledger l ON l.tenant_id = t.id
      ${where}
      GROUP BY r.id
      ORDER BY r.room_number
    `, params);
    res.json({ success: true, data: rooms });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/rooms/:id', (req, res) => {
  try {
    const room = get(`
      SELECT r.*, p.name as property_name, p.type as property_type,
        t.id as tenant_id, t.name as tenant_name, t.weekly_rent,
        t.bond, t.move_in, t.move_out, t.status as tenant_status, t.notes
      FROM rooms r
      LEFT JOIN properties p ON p.id = r.property_id
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
    const { room_number, description, property_id } = req.body;
    if (!room_number) return res.status(400).json({ success: false, error: 'room_number is required' });
    const result = run(`INSERT INTO rooms (property_id, room_number, description) VALUES (?, ?, ?)`,
      [property_id || null, room_number, description || '']);
    res.json({ success: true, data: { id: result.lastInsertRowid } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/rooms/:id', (req, res) => {
  try {
    const { room_number, description, property_id } = req.body;
    const existing = get('SELECT * FROM rooms WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Room not found' });
    run(`UPDATE rooms SET room_number=?, description=?, property_id=? WHERE id=?`,
      [room_number, description || '', property_id !== undefined ? property_id : existing.property_id, req.params.id]);
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
    const { status, room_id, property_id } = req.query;
    let query = `
      SELECT t.*, r.room_number, r.property_id,
        p.name as property_name, p.type as property_type,
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
      LEFT JOIN properties p ON p.id = r.property_id
      LEFT JOIN ledger l ON l.tenant_id = t.id
      WHERE 1=1
    `;
    const params = [];
    if (status)      { query += ' AND t.status = ?';      params.push(status); }
    if (room_id)     { query += ' AND t.room_id = ?';     params.push(room_id); }
    if (property_id) { query += ' AND r.property_id = ?'; params.push(property_id); }
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
      SELECT t.*, r.room_number, r.property_id,
        p.name as property_name, p.type as property_type,
        COALESCE(SUM(CASE WHEN l.status = '✓ Paid' THEN l.amount ELSE 0 END), 0) as total_received
      FROM tenants t
      JOIN rooms r ON r.id = t.room_id
      LEFT JOIN properties p ON p.id = r.property_id
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
    const { tenant_status, property_id } = req.query;
    let query = `
      SELECT bp.*, t.name as tenant_name, t.status as tenant_status, r.room_number, r.property_id
      FROM bond_payments bp
      JOIN tenants t ON t.id = bp.tenant_id
      JOIN rooms r ON r.id = t.room_id
      WHERE 1=1
    `;
    const params = [];
    if (tenant_status) { query += ' AND t.status = ?';      params.push(tenant_status); }
    if (property_id)   { query += ' AND r.property_id = ?'; params.push(property_id); }
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
    const { property_id } = req.query;
    let where = '';
    const params = [];
    if (property_id) { where = 'WHERE e.property_id = ?'; params.push(property_id); }
    const expenses = all(`
      SELECT e.*, p.name as property_name
      FROM expenses e
      LEFT JOIN properties p ON p.id = e.property_id
      ${where}
      ORDER BY e.date DESC
    `, params);
    res.json({ success: true, data: expenses });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/expenses', (req, res) => {
  try {
    const { date, description, amount, category, notes, property_id } = req.body;
    const result = run(`
      INSERT INTO expenses (property_id, date, description, amount, category, notes) VALUES (?, ?, ?, ?, ?, ?)
    `, [property_id || null, date, description, amount, category || 'General', notes || '']);
    res.json({ success: true, data: { id: result.lastInsertRowid } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/expenses/:id', (req, res) => {
  try {
    const { date, description, amount, category, notes, property_id } = req.body;
    const existing = get('SELECT * FROM expenses WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });
    run(`
      UPDATE expenses SET property_id=?, date=?, description=?, amount=?, category=?, notes=? WHERE id=?
    `, [property_id !== undefined ? (property_id || null) : existing.property_id,
        date, description, amount, category, notes || '', req.params.id]);
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
    const { property_id } = req.query;
    const p = property_id ? [property_id] : [];

    // Build filter fragments — join through rooms when filtering by property
    const lJoin  = property_id ? 'JOIN tenants _lt ON _lt.id = l.tenant_id JOIN rooms _lr ON _lr.id = _lt.room_id' : '';
    const lWhere = property_id ? 'WHERE _lr.property_id = ?' : 'WHERE 1=1';
    const tJoin  = property_id ? 'JOIN rooms _tr ON _tr.id = t.room_id' : '';
    const tWhere = property_id ? 'WHERE _tr.property_id = ?' : 'WHERE 1=1';
    const bJoin  = property_id ? 'JOIN tenants _bt ON _bt.id = bp.tenant_id JOIN rooms _br ON _br.id = _bt.room_id' : '';
    const bWhere = property_id ? 'WHERE _br.property_id = ?' : 'WHERE 1=1';
    const eWhere = property_id ? 'WHERE property_id = ?' : 'WHERE 1=1';

    const incomeResult = get(`SELECT COALESCE(SUM(l.amount),0) as total FROM ledger l ${lJoin} ${lWhere} AND l.status='✓ Paid'`, p);
    const income = incomeResult ? incomeResult.total : 0;

    const expensesResult = get(`SELECT COALESCE(SUM(amount),0) as total FROM expenses ${eWhere}`, p);
    const expenses = expensesResult ? expensesResult.total : 0;

    const bondResult = get(`
      SELECT
        COALESCE(SUM(bp.amount),0) as collected,
        COALESCE(SUM(CASE WHEN bp.refund_date IS NOT NULL THEN COALESCE(bp.refund_amount,bp.amount) ELSE 0 END),0) as refunded
      FROM bond_payments bp ${bJoin} ${bWhere}
    `, p);
    const bond = bondResult || { collected: 0, refunded: 0 };

    const activeRoomsResult = get(`SELECT COUNT(*) as c FROM tenants t ${tJoin} ${tWhere} AND t.status='Active'`, p);
    const activeRooms = activeRoomsResult ? activeRoomsResult.c : 0;

    const pendingWeeksResult = get(`SELECT COUNT(*) as c FROM ledger l ${lJoin} ${lWhere} AND l.status='Pending'`, p);
    const pendingWeeks = pendingWeeksResult ? pendingWeeksResult.c : 0;

    const recentLedger = all(`
      SELECT l.*, t.name as tenant_name, r.room_number
      FROM ledger l
      JOIN tenants t ON t.id = l.tenant_id
      JOIN rooms r ON r.id = t.room_id
      ${property_id ? 'WHERE r.property_id = ?' : ''}
      ORDER BY l.start_date DESC LIMIT 10
    `, p);

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

// ─── API: Reports ─────────────────────────────────────────────────────────────

// Income Summary — monthly breakdown of ledger entries
app.get('/api/reports/income-summary', (req, res) => {
  try {
    const { from, to, property_id } = req.query;
    const params = [];
    const join  = property_id ? 'JOIN tenants _t ON _t.id = l.tenant_id JOIN rooms _r ON _r.id = _t.room_id' : '';
    let where = 'WHERE 1=1';
    if (from)        { where += ' AND l.start_date >= ?'; params.push(from); }
    if (to)          { where += ' AND l.start_date <= ?'; params.push(to); }
    if (property_id) { where += ' AND _r.property_id = ?'; params.push(property_id); }

    const rows = all(`
      SELECT
        strftime('%Y-%m', l.start_date) as month,
        COALESCE(SUM(CASE WHEN l.status = '✓ Paid'  THEN COALESCE(l.amount,0) ELSE 0 END), 0) as paid_amount,
        COALESCE(SUM(CASE WHEN l.status = 'Pending'  THEN COALESCE(l.amount,0) ELSE 0 END), 0) as pending_amount,
        COALESCE(SUM(CASE WHEN l.status = 'Waived'   THEN COALESCE(l.amount,0) ELSE 0 END), 0) as waived_amount,
        COUNT(CASE WHEN l.status = '✓ Paid'  THEN 1 END) as paid_count,
        COUNT(CASE WHEN l.status = 'Pending'  THEN 1 END) as pending_count,
        COUNT(CASE WHEN l.status = 'Waived'   THEN 1 END) as waived_count,
        COUNT(*) as total_count
      FROM ledger l ${join} ${where}
      GROUP BY month
      ORDER BY month DESC
    `, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rent Collection — per-tenant payment breakdown
app.get('/api/reports/rent-collection', (req, res) => {
  try {
    const { from, to, status, property_id } = req.query;
    const params = [];
    let lWhere = '';
    if (from) { lWhere += ' AND l.start_date >= ?'; params.push(from); }
    if (to)   { lWhere += ' AND l.start_date <= ?'; params.push(to); }
    if (status && status !== 'All') { params.push(status); }
    if (property_id) { params.push(property_id); }

    const rows = all(`
      SELECT
        t.id, t.name, r.room_number, r.property_id,
        p.name as property_name, p.type as property_type,
        t.weekly_rent, t.move_in, t.move_out, t.status,
        COUNT(l.id) as total_weeks,
        COALESCE(SUM(CASE WHEN l.status = '✓ Paid'  THEN 1 ELSE 0 END), 0) as paid_weeks,
        COALESCE(SUM(CASE WHEN l.status = 'Pending'  THEN 1 ELSE 0 END), 0) as pending_weeks,
        COALESCE(SUM(CASE WHEN l.status = 'Waived'   THEN 1 ELSE 0 END), 0) as waived_weeks,
        COALESCE(SUM(CASE WHEN l.status = '✓ Paid'  THEN l.amount ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(CASE WHEN l.status = 'Pending'  THEN l.amount ELSE 0 END), 0) as total_pending
      FROM tenants t
      JOIN rooms r ON r.id = t.room_id
      LEFT JOIN properties p ON p.id = r.property_id
      LEFT JOIN ledger l ON l.tenant_id = t.id ${lWhere}
      WHERE 1=1
        ${(status && status !== 'All') ? 'AND t.status = ?' : ''}
        ${property_id ? 'AND r.property_id = ?' : ''}
      GROUP BY t.id
      ORDER BY t.status, r.room_number
    `, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Profit & Loss — monthly income vs expenses
app.get('/api/reports/profit-loss', (req, res) => {
  try {
    const { from, to, property_id } = req.query;

    const lParams = [];
    const lJoin  = property_id ? 'JOIN tenants _t ON _t.id = l.tenant_id JOIN rooms _r ON _r.id = _t.room_id' : '';
    let lWhere = 'WHERE 1=1';
    if (from)        { lWhere += ' AND l.start_date >= ?'; lParams.push(from); }
    if (to)          { lWhere += ' AND l.start_date <= ?'; lParams.push(to); }
    if (property_id) { lWhere += ' AND _r.property_id = ?'; lParams.push(property_id); }

    const eParams = [];
    let eWhere = 'WHERE 1=1';
    if (from)        { eWhere += ' AND date >= ?'; eParams.push(from); }
    if (to)          { eWhere += ' AND date <= ?'; eParams.push(to); }
    if (property_id) { eWhere += ' AND property_id = ?'; eParams.push(property_id); }

    const incomeRows = all(`
      SELECT strftime('%Y-%m', l.start_date) as month,
        COALESCE(SUM(CASE WHEN l.status = '✓ Paid' THEN l.amount ELSE 0 END), 0) as income
      FROM ledger l ${lJoin} ${lWhere} GROUP BY month
    `, lParams);

    const expRows = all(`
      SELECT strftime('%Y-%m', date) as month,
        COALESCE(SUM(amount), 0) as expenses
      FROM expenses ${eWhere} GROUP BY month
    `, eParams);

    const months = {};
    incomeRows.forEach(r => {
      if (!months[r.month]) months[r.month] = { month: r.month, income: 0, expenses: 0 };
      months[r.month].income = r.income;
    });
    expRows.forEach(r => {
      if (!months[r.month]) months[r.month] = { month: r.month, income: 0, expenses: 0 };
      months[r.month].expenses = r.expenses;
    });

    const data = Object.values(months)
      .map(r => ({ month: r.month, income: r.income, expenses: r.expenses, profit: r.income - r.expenses }))
      .sort((a, b) => b.month.localeCompare(a.month));

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Occupancy — tenant history per room
app.get('/api/reports/occupancy', (req, res) => {
  try {
    const { property_id } = req.query;
    let where = '';
    const params = [];
    if (property_id) { where = 'WHERE r.property_id = ?'; params.push(property_id); }

    const rows = all(`
      SELECT
        r.id as room_id, r.room_number, r.description, r.property_id,
        p.name as property_name, p.type as property_type,
        t.id as tenant_id, t.name, t.move_in, t.move_out, t.status,
        t.weekly_rent, t.bond,
        COALESCE(SUM(CASE WHEN l.status = '✓ Paid' THEN l.amount ELSE 0 END), 0) as total_paid
      FROM rooms r
      LEFT JOIN properties p ON p.id = r.property_id
      LEFT JOIN tenants t ON t.room_id = r.id
      LEFT JOIN ledger l ON l.tenant_id = t.id
      ${where}
      GROUP BY r.id, t.id
      ORDER BY r.room_number, t.created_at DESC
    `, params);
    res.json({ success: true, data: rows });
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
