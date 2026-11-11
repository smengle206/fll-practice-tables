const path = require('path');
const express = require('express');
const db = require('./db');
const admin = require('./admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true); // Railway terminates HTTPS in front of the app
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// Health check: Railway (and you) can hit this to confirm the app and database are up.
app.get('/health', async (req, res) => {
  const database = await db.checkConnection();
  res.json({
    ok: true,
    database,
    adminPasswordSet: Boolean(process.env.ADMIN_PASSWORD),
    time: new Date().toISOString(),
  });
});

app.use('/api/admin', admin.router);

// Turn unexpected errors into JSON instead of crashing the request.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error: ' + err.message });
});

db.migrate()
  .then(() => console.log('Database ready'))
  .catch(err => console.error('Database migration failed:', err.message))
  .finally(() => {
    app.listen(PORT, () => console.log(`FLL practice tables listening on port ${PORT}`));
  });
