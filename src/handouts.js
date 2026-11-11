const QRCode = require('qrcode');
const db = require('./db');

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Printable coach handouts: four per US-letter page, each with the team's PIN,
// a QR code to the booking page and short instructions.
async function handoutsPage(req, res) {
  const site = `${req.protocol}://${req.get('host')}`;
  const ids = String(req.query.teams || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
  const { rows: teams } = ids.length
    ? await db.query('SELECT number, name, pin FROM teams WHERE id = ANY($1) ORDER BY number', [ids])
    : await db.query('SELECT number, name, pin FROM teams ORDER BY number');
  const { rows: s } = await db.query("SELECT value FROM settings WHERE key = 'slot_minutes'");
  const mins = s.length ? s[0].value : '10';

  const qr = await QRCode.toString(site, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });

  const cards = teams.map(t => `
    <div class="card">
      <div class="top">FLL Practice Tables</div>
      <div class="team">Team #${esc(t.number)}</div>
      <div class="name">${esc(t.name || '')}</div>
      <div class="pinbox"><span>Your PIN</span><b>${esc(t.pin)}</b></div>
      <div class="mid">
        <div class="qr">${qr}</div>
        <ol>
          <li>Scan the code or go to<br><span class="url">${esc(site.replace(/^https?:\/\//, ''))}</span></li>
          <li>Choose your team and enter the PIN.</li>
          <li>Tap <b>Reserve</b> on an open slot.</li>
        </ol>
      </div>
      <ul class="rules">
        <li>Slots are ${esc(mins)} minutes. Your table number is shown after you book.</li>
        <li>You can hold one upcoming slot. Book your next one once your slot starts.</li>
        <li>Need to cancel or change? Ask a practice-area volunteer.</li>
        <li>Keep this PIN within your team.</li>
      </ul>
    </div>`).join('');

  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Team PIN handouts</title>
<style>
  @page { size: letter; margin: 0.4in; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Arial, sans-serif; color: #1d2330; }
  .bar { padding: 12px 16px; background: #1d2330; color: #fff; display: flex; gap: 16px; align-items: center; }
  .bar button { font: inherit; padding: 6px 14px; border: 0; border-radius: 6px; background: #4c8dff; color: #fff; cursor: pointer; }
  .sheet { display: grid; grid-template-columns: 3.85in 3.85in; grid-auto-rows: 5.1in; width: 7.7in; margin: 0 auto; }
  .card { border: 1px dashed #9aa3b2; padding: 0.28in 0.3in; display: flex; flex-direction: column; break-inside: avoid; overflow: hidden; }
  .top { font-size: 9pt; text-transform: uppercase; letter-spacing: .12em; color: #667085; font-weight: 600; }
  .team { font-size: 26pt; font-weight: 800; margin-top: 4pt; line-height: 1.1; }
  .name { font-size: 12pt; color: #475467; min-height: 15pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pinbox { margin: 10pt 0; border: 2px solid #1d2330; border-radius: 8pt; padding: 6pt 10pt; display: flex; justify-content: space-between; align-items: center; }
  .pinbox span { font-size: 10pt; text-transform: uppercase; letter-spacing: .1em; color: #475467; font-weight: 600; }
  .pinbox b { font-size: 28pt; letter-spacing: .2em; font-variant-numeric: tabular-nums; }
  .mid { display: flex; gap: 10pt; align-items: center; }
  .qr { width: 1.15in; height: 1.15in; flex: none; }
  .qr svg { width: 100%; height: 100%; }
  ol { margin: 0; padding-left: 14pt; font-size: 9.5pt; line-height: 1.35; }
  ol li { margin-bottom: 3pt; }
  .url { font-weight: 700; word-break: break-all; }
  .rules { margin: auto 0 0; padding: 8pt 0 0 12pt; border-top: 1px solid #e3e6eb; font-size: 8.5pt; line-height: 1.35; color: #344054; }
  .empty { padding: 2rem; text-align: center; color: #667085; }
  @media print { .bar { display: none; } }
</style></head>
<body>
  <div class="bar"><span>${teams.length} handout(s) · 4 per letter page · cut on the dashed lines</span><button onclick="print()">Print</button></div>
  ${teams.length ? `<div class="sheet">${cards}</div>` : '<div class="empty">No teams yet. Add teams on the admin page first.</div>'}
</body></html>`);
}

module.exports = { handoutsPage };
