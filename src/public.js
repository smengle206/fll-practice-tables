const express = require('express');
const db = require('./db');
const { getSettings } = require('./admin');
const { PUBLIC_URL } = require('./config');

const router = express.Router();

// ---------- PIN attempt limiting ----------
// After 8 wrong PINs for a team, that team is locked out of PIN checks for 10 minutes.
const MAX_FAILS = 8;
const LOCK_MS = 10 * 60 * 1000;
const fails = new Map(); // team_id -> { count, until }

function lockedOut(teamId) {
  const f = fails.get(teamId);
  if (!f) return false;
  if (f.until && f.until < Date.now()) { fails.delete(teamId); return false; }
  return Boolean(f.until);
}

function recordFail(teamId) {
  const f = fails.get(teamId) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= MAX_FAILS) f.until = Date.now() + LOCK_MS;
  fails.set(teamId, f);
}

// Checks team_id + pin from the request body. Returns the team row or sends an error.
async function checkTeam(req, res, q = db) {
  const teamId = Number(req.body && req.body.team_id);
  const pin = String((req.body && req.body.pin) || '').trim();
  if (!Number.isInteger(teamId)) { res.status(400).json({ error: 'Pick your team' }); return null; }
  if (lockedOut(teamId)) {
    res.status(429).json({ error: 'Too many wrong PINs. Try again in a few minutes or ask a volunteer.' });
    return null;
  }
  const { rows } = await q.query('SELECT id, number, name, pin FROM teams WHERE id = $1', [teamId]);
  if (!rows.length) { res.status(404).json({ error: 'Team not found' }); return null; }
  if (rows[0].pin !== pin) {
    recordFail(teamId);
    res.status(401).json({ error: 'Wrong PIN for this team' });
    return null;
  }
  fails.delete(teamId);
  return rows[0];
}

// The team's reservations that haven't finished yet (at most one upcoming + one in progress).
async function teamReservations(teamId, q = db) {
  const { rows } = await q.query(`
    SELECT r.id, r.table_no, s.start_at,
           s.start_at + make_interval(mins => s.duration_min) AS end_at
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.team_id = $1 AND s.start_at + make_interval(mins => s.duration_min) > now()
    ORDER BY s.start_at`, [teamId]);
  const now = Date.now();
  return {
    upcoming: rows.find(r => new Date(r.start_at).getTime() > now) || null,
    current: rows.find(r => new Date(r.start_at).getTime() <= now) || null,
  };
}

const publicTeam = t => ({ id: t.id, number: t.number, name: t.name });

// ---------- routes ----------

router.get('/teams', async (req, res) => {
  const { rows } = await db.query('SELECT id, number, name FROM teams ORDER BY number');
  res.json(rows);
});

// All slots for the event with how many tables are taken. Team numbers are included
// so the TV display can show who's on which table.
router.get('/slots', async (req, res) => {
  const settings = await getSettings();
  const { rows } = await db.query(`
    SELECT s.id, s.start_at, s.duration_min,
           s.start_at + make_interval(mins => s.duration_min) AS end_at,
           COALESCE(json_agg(json_build_object('table_no', r.table_no, 'team_number', t.number, 'team_name', t.name)
                    ORDER BY r.table_no) FILTER (WHERE r.id IS NOT NULL), '[]') AS reservations
    FROM slots s
    LEFT JOIN reservations r ON r.slot_id = s.id
    LEFT JOIN teams t ON t.id = r.team_id
    GROUP BY s.id
    ORDER BY s.start_at`);
  res.json({
    now: new Date().toISOString(),
    public_url: PUBLIC_URL,
    tables_per_slot: settings.tables_per_slot,
    slots: rows,
  });
});

// Sign in check + current booking status: { team_id, pin }
router.post('/status', async (req, res) => {
  const team = await checkTeam(req, res);
  if (!team) return;
  res.json({ now: new Date().toISOString(), team: publicTeam(team), ...(await teamReservations(team.id)) });
});

// Book a slot: { team_id, pin, slot_id }. The table is assigned automatically.
router.post('/reserve', async (req, res) => {
  const slotId = Number(req.body && req.body.slot_id);
  if (!Number.isInteger(slotId)) return res.status(400).json({ error: 'Pick a timeslot' });

  const result = await db.withTransaction(async c => {
    const team = await checkTeam(req, res, c);
    if (!team) return null;

    // Lock the team row so two quick taps (or two phones) can't double-book.
    await c.query('SELECT id FROM teams WHERE id = $1 FOR UPDATE', [team.id]);
    const { upcoming } = await teamReservations(team.id, c);
    if (upcoming) {
      res.status(409).json({ error: 'Your team already has an upcoming slot. You can book another once it begins.' });
      return null;
    }

    const { rows: slotRows } = await c.query(
      'SELECT id, start_at FROM slots WHERE id = $1 FOR UPDATE', [slotId]);
    if (!slotRows.length) { res.status(404).json({ error: 'That timeslot no longer exists' }); return null; }
    if (new Date(slotRows[0].start_at).getTime() <= Date.now()) {
      res.status(409).json({ error: 'That timeslot has already started' }); return null;
    }

    const settings = await getSettings(c);
    const { rows: taken } = await c.query(
      'SELECT table_no, team_id FROM reservations WHERE slot_id = $1', [slotId]);
    if (taken.some(r => r.team_id === team.id)) {
      res.status(409).json({ error: 'Your team is already in that timeslot' }); return null;
    }
    const used = new Set(taken.map(r => r.table_no));
    let table = 0;
    for (let i = 1; i <= settings.tables_per_slot; i++) if (!used.has(i)) { table = i; break; }
    if (!table) { res.status(409).json({ error: 'That timeslot just filled up. Pick another.' }); return null; }

    await c.query('INSERT INTO reservations (slot_id, team_id, table_no) VALUES ($1, $2, $3)',
      [slotId, team.id, table]);
    return team;
  });
  if (!result) return;
  res.json({ now: new Date().toISOString(), team: publicTeam(result), ...(await teamReservations(result.id)) });
});

module.exports = { router };
