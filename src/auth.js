const crypto = require('crypto');

const COOKIE = 'fll_admin';
const MAX_AGE_SEC = 60 * 60 * 24 * 3; // stay signed in for 3 days

function password() {
  return process.env.ADMIN_PASSWORD || '';
}

// The cookie holds an expiry time signed with the admin password,
// so changing ADMIN_PASSWORD signs everyone out.
function sign(expires) {
  return crypto.createHmac('sha256', password()).update(String(expires)).digest('hex');
}

function makeToken() {
  const expires = Math.floor(Date.now() / 1000) + MAX_AGE_SEC;
  return `${expires}.${sign(expires)}`;
}

function validToken(token) {
  if (!token || !password()) return false;
  const [expires, sig] = token.split('.');
  if (!expires || !sig || Number(expires) < Date.now() / 1000) return false;
  const expected = sign(expires);
  return sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isAdmin(req) {
  return validToken(readCookie(req, COOKIE));
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Admin login required' });
}

function login(req, res) {
  if (!password()) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD is not set on the server' });
  }
  const given = String((req.body && req.body.password) || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(password()).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${makeToken()}; HttpOnly; Path=/; Max-Age=${MAX_AGE_SEC}; SameSite=Lax${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
}

function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
}

module.exports = { requireAdmin, isAdmin, login, logout };
