const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const auth = require('./auth');

const TZ = 'America/New_York';
const router = express.Router();

router.post('/login', auth.login);
router.post('/logout', auth.logout);
router.get('/me', (req, res) => res.json({ admin: auth.isAdmin(req) }));

router.use(auth.requireAdmin);

// ---------- helpers ----------

async function getSettings(q = db) {
  const { rows } = await q.query('SELECT key, value FROM settings');
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    slot_minutes: Number(s.slot_minutes),
    tables_per_slot: Number(s.tables_per_slot),
    event_date: s.event_date,
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}

// Inserts one slot unless it overlaps an existing one. Returns true if inserted.
// The start time is an Eastern wall-clock time on the event date.
async function insertSlot(client, eventDate, startMinutes, duration) {
  const { rowCount } = await client.query(`
    WITH new AS (
      SELECT (($1::date + make_interval(mins => $2)) AT TIME ZONE '${TZ}') AS start_at,
             $3::int AS duration_min
    )
    INSERT INTO slots (start_at, duration_min)
    SELECT start_at, duration_min FROM new
    WHERE NOT EXISTS (
      SELECT 1 FROM slots s, new
      WHERE s.start_at < new.start_at + make_interval(mins => new.duration_min)
        AND s.start_at + make_interval(mins => s.duration_min) > new.start_at
    )`, [eventDate, startMinutes, duration]);
  return rowCount === 1;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// ---------- settings ----------

router.get('/settings', async (req, res) => {
  res.json(await getSettings());
});

router.put('/settings', async (req, res) => {
  const { slot_minutes, tables_per_slot, event_date } = req.body || {};
  const mins = Number(slot_minutes);
  const tables = Number(tables_per_slot);
  if (!Number.isInteger(mins) || mins < 1 || mins > 240) return badRequest(res, 'Slot length must be 1–240 minutes');
  if (!Number.isInteger(tables) || tables < 1 || tables > 20) return badRequest(res, 'Tables per slot must be 1–20');
  if (!DATE_RE.test(String(event_date || ''))) return badRequest(res, 'Event date must be YYYY-MM-DD');

  await db.query(`
    INSERT INTO settings (key, value) VALUES
      ('slot_minutes', $1), ('tables_per_slot', $2), ('event_date', $3)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(mins), String(tables), event_date]);
  res.json(await getSettings());
});

// ---------- slots ----------

router.get('/slots', async (req, res) => {
  const settings = await getSettings();
  const { rows } = await db.query(`
    SELECT s.id, s.start_at, s.duration_min,
           s.start_at + make_interval(mins => s.duration_min) AS end_at,
           COUNT(r.id)::int AS reserved,
           COALESCE(json_agg(json_build_object('id', r.id, 'table_no', r.table_no, 'team_number', t.number, 'team_name', t.name)
                    ORDER BY r.table_no) FILTER (WHERE r.id IS NOT NULL), '[]') AS reservations
    FROM slots s
    LEFT JOIN reservations r ON r.slot_id = s.id
    LEFT JOIN teams t ON t.id = r.team_id
    GROUP BY s.id
    ORDER BY s.start_at`);
  res.json({ settings, slots: rows });
});

// Add one slot: { start: "HH:MM" }
router.post('/slots', async (req, res) => {
  const start = String((req.body && req.body.start) || '');
  if (!TIME_RE.test(start)) return badRequest(res, 'Start time must be HH:MM');
  const settings = await getSettings();
  const ok = await db.withTransaction(c =>
    insertSlot(c, settings.event_date, toMinutes(start), settings.slot_minutes));
  if (!ok) return res.status(409).json({ error: 'That slot overlaps an existing slot' });
  res.json({ created: 1 });
});

// Add a run of back-to-back slots: { from: "HH:MM", to: "HH:MM" }
// Every slot must end by "to". Slots that would overlap existing ones are skipped.
router.post('/slots/bulk', async (req, res) => {
  const from = String((req.body && req.body.from) || '');
  const to = String((req.body && req.body.to) || '');
  if (!TIME_RE.test(from) || !TIME_RE.test(to)) return badRequest(res, 'Times must be HH:MM');
  const startMin = toMinutes(from);
  const endMin = toMinutes(to);
  if (endMin <= startMin) return badRequest(res, 'End time must be after start time');

  const settings = await getSettings();
  const len = settings.slot_minutes;
  const result = await db.withTransaction(async c => {
    let created = 0, skipped = 0;
    for (let m = startMin; m + len <= endMin; m += len) {
      (await insertSlot(c, settings.event_date, m, len)) ? created++ : skipped++;
    }
    return { created, skipped };
  });
  res.json(result);
});

router.delete('/slots/:id', async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM slots WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Slot not found' });
  res.json({ deleted: 1 });
});

// Delete every slot (and their reservations). Requires { confirm: "DELETE" }.
router.post('/slots/delete-all', async (req, res) => {
  if ((req.body && req.body.confirm) !== 'DELETE') return badRequest(res, 'Confirmation missing');
  const { rowCount } = await db.query('DELETE FROM slots');
  res.json({ deleted: rowCount });
});

// ---------- reservations ----------

router.delete('/reservations/:id', async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM reservations WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Reservation not found' });
  res.json({ deleted: 1 });
});

// Event-day reset: removes every reservation, keeps teams and PINs.
// { confirm: "RESET", delete_slots?: boolean } — delete_slots also removes all timeslots.
router.post('/reset', async (req, res) => {
  const body = req.body || {};
  if (body.confirm !== 'RESET') return badRequest(res, 'Confirmation missing');
  const result = await db.withTransaction(async c => {
    const r = await c.query('DELETE FROM reservations');
    const s = body.delete_slots ? await c.query('DELETE FROM slots') : { rowCount: 0 };
    return { reservations_deleted: r.rowCount, slots_deleted: s.rowCount };
  });
  res.json(result);
});

// ---------- teams ----------

// Printable handouts (HTML page). ?teams=1,2,3 limits it to those team ids.
router.get('/handouts', require('./handouts').handoutsPage);

const PIN_RE = /^\d{4,6}$/;
const newPin = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

router.get('/teams', async (req, res) => {
  const { rows } = await db.query(`
    SELECT t.id, t.number, t.name, t.pin, COUNT(r.id)::int AS reservations
    FROM teams t LEFT JOIN reservations r ON r.team_id = t.id
    GROUP BY t.id ORDER BY t.number`);
  res.json(rows);
});

// Add or update teams from pasted text, one team per line:
//   number, name[, pin]     (comma or tab separated; name and pin optional)
// Existing team numbers get their name updated (and PIN, if one is given).
router.post('/teams/import', async (req, res) => {
  const text = String((req.body && req.body.text) || '');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return badRequest(res, 'Paste at least one team');

  const parsed = [];
  const errors = [];
  lines.forEach((line, i) => {
    const parts = line.split(/\t|,/).map(p => p.trim());
    const number = Number(parts[0]);
    const name = parts[1] || '';
    const pin = parts[2] || '';
    if (!Number.isInteger(number) || number < 1) errors.push(`Line ${i + 1}: "${parts[0]}" is not a team number`);
    else if (pin && !PIN_RE.test(pin)) errors.push(`Line ${i + 1}: PIN must be 4–6 digits`);
    else parsed.push({ number, name: name.slice(0, 100), pin });
  });
  if (errors.length) return badRequest(res, errors.slice(0, 5).join('; '));

  const result = await db.withTransaction(async c => {
    let added = 0, updated = 0;
    for (const t of parsed) {
      const { rows } = await c.query(`
        INSERT INTO teams (number, name, pin) VALUES ($1, $2, $3)
        ON CONFLICT (number) DO UPDATE
          SET name = EXCLUDED.name,
              pin = CASE WHEN $4 THEN EXCLUDED.pin ELSE teams.pin END
        RETURNING (xmax = 0) AS inserted`,
        [t.number, t.name, t.pin || newPin(), Boolean(t.pin)]);
      rows[0].inserted ? added++ : updated++;
    }
    return { added, updated };
  });
  res.json(result);
});

// Edit one team: { name?, pin? }  — pin "new" generates a fresh random PIN.
router.put('/teams/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { name, pin } = req.body || {};
  const sets = [], vals = [];
  if (name !== undefined) { vals.push(String(name).trim().slice(0, 100)); sets.push(`name = $${vals.length}`); }
  if (pin !== undefined) {
    const p = pin === 'new' ? newPin() : String(pin).trim();
    if (!PIN_RE.test(p)) return badRequest(res, 'PIN must be 4–6 digits');
    vals.push(p); sets.push(`pin = $${vals.length}`);
  }
  if (!sets.length) return badRequest(res, 'Nothing to change');
  vals.push(id);
  const { rows } = await db.query(
    `UPDATE teams SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, number, name, pin`, vals);
  if (!rows.length) return res.status(404).json({ error: 'Team not found' });
  res.json(rows[0]);
});

router.delete('/teams/:id', async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM teams WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Team not found' });
  res.json({ deleted: 1 });
});

module.exports = { router, getSettings };
