const path = require('path');
const express = require('express');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check: Railway (and you) can hit this to confirm the app and database are up.
app.get('/health', async (req, res) => {
  const database = await db.checkConnection();
  res.json({ ok: true, database, time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`FLL practice tables listening on port ${PORT}`);
});
