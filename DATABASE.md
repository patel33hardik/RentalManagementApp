# Database Schema & Relationships

## Visual Schema

```
┌─────────────────────────────┐
│           rooms             │
├─────────────────────────────┤
│ PK  id          INTEGER     │
│     room_number INTEGER     │
│     description TEXT        │
└──────────────┬──────────────┘
               │ 1
               │ one room can hold many tenants
               │ over time (only 1 Active at once)
               │ ∞
┌──────────────▼──────────────┐
│           tenants           │
├─────────────────────────────┤
│ PK  id          INTEGER     │
│ FK  room_id     → rooms.id  │
│     name        TEXT        │
│     weekly_rent REAL        │
│     bond        REAL        │
│     move_in     TEXT        │
│     move_out    TEXT        │
│     status      TEXT        │  ← 'Active' | 'Inactive'
│     notes       TEXT        │
│     created_at  TEXT        │
└──────┬───────────────┬──────┘
       │               │
       │ 1             │ 1
       │               │
       │ ∞             │ ∞
┌──────▼──────┐  ┌─────▼────────────────────┐
│   ledger    │  │      bond_payments        │
├─────────────┤  ├───────────────────────────┤
│ PK id       │  │ PK  id         INTEGER    │
│ FK tenant_id│  │ FK  tenant_id  → tenants  │
│  start_date │  │     date       TEXT       │
│  end_date   │  │     amount     REAL       │
│  amount     │  │     bank_ref   TEXT       │
│  bank_ref   │  │     type       TEXT       │  ← 'Collected' | 'Refunded'
│  pay_date   │  │     notes      TEXT       │
│  status     │  │     created_at TEXT       │
│  notes      │  └───────────────────────────┘
│  created_at │
└─────────────┘
  status values:
  'Pending' | '✓ Paid' | 'Waived'


┌─────────────────────────────┐
│          expenses           │   (standalone — no FK)
├─────────────────────────────┤
│ PK  id          INTEGER     │
│     date        TEXT        │
│     description TEXT        │
│     amount      REAL        │
│     category    TEXT        │
│     notes       TEXT        │
│     created_at  TEXT        │
└─────────────────────────────┘
  categories: Utilities | Maintenance |
              Insurance | Council Rates | General
```

---

## Tables

### `rooms`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `room_number` | INTEGER | Unique |
| `description` | TEXT | e.g. "Master Bedroom" |

---

### `tenants`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `room_id` | INTEGER FK | → `rooms.id` |
| `name` | TEXT | Required |
| `weekly_rent` | REAL | Required |
| `bond` | REAL | Default 0 |
| `move_in` | TEXT | ISO date `YYYY-MM-DD` |
| `move_out` | TEXT | ISO date `YYYY-MM-DD` |
| `status` | TEXT | `'Active'` \| `'Inactive'` |
| `notes` | TEXT | |
| `created_at` | TEXT | Auto — local datetime |

---

### `ledger`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `tenant_id` | INTEGER FK | → `tenants.id` |
| `start_date` | TEXT | ISO date |
| `end_date` | TEXT | ISO date |
| `amount` | REAL | Null until paid |
| `bank_ref` | TEXT | Bank transfer reference |
| `pay_date` | TEXT | ISO date |
| `status` | TEXT | `'Pending'` \| `'✓ Paid'` \| `'Waived'` |
| `notes` | TEXT | |
| `created_at` | TEXT | Auto — local datetime |

---

### `bond_payments`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `tenant_id` | INTEGER FK | → `tenants.id` |
| `date` | TEXT | ISO date |
| `amount` | REAL | Required |
| `bank_ref` | TEXT | |
| `type` | TEXT | `'Collected'` \| `'Refunded'` |
| `notes` | TEXT | |
| `created_at` | TEXT | Auto — local datetime |

---

### `expenses`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `date` | TEXT | ISO date |
| `description` | TEXT | Required |
| `amount` | REAL | Default 0 |
| `category` | TEXT | `Utilities` \| `Maintenance` \| `Insurance` \| `Council Rates` \| `General` |
| `notes` | TEXT | |
| `created_at` | TEXT | Auto — local datetime |

---

## Relationships

| From | To | Type | Rule |
|---|---|---|---|
| `rooms` → `tenants` | One-to-Many | One room, many tenants over time | Only 1 `Active` per room at a time — adding a new Active tenant auto-sets the previous one to `Inactive` |
| `tenants` → `ledger` | One-to-Many | One tenant, many weekly rows | Auto-generates 12 `Pending` rows on tenant creation, aligned to Monday from move-in date |
| `tenants` → `bond_payments` | One-to-Many | One tenant, many payment events | `Collected` = bond taken on move-in; `Refunded` = bond returned on move-out |
| `expenses` | Standalone | No relationships | Tracks property-wide costs independently of rooms or tenants |

---

## Key Business Rules

- **Current tenant for a room** — `SELECT * FROM tenants WHERE room_id = ? AND status = 'Active'`
- **Outstanding rent** — `SELECT * FROM ledger WHERE tenant_id = ? AND status = 'Pending'`
- **Bond held per tenant** — `SUM(amount) WHERE type='Collected'` minus `SUM(amount) WHERE type='Refunded'`
- **Net profit** — Total `ledger` income (`✓ Paid`) minus total `expenses`
- **Database persistence** — Uses sql.js (in-memory SQLite). Loaded from `db/rental_manager.db` on startup, auto-saved to disk every 10 seconds and on process exit.
