'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { open } = require('./lib/db');
const { computeShares, simplify } = require('./lib/split');
const { parseBill, recognize } = require('./lib/ocr');

const crypto = require('crypto');
const SESSION_MS = 30 * 24 * 3600 * 1000;
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '200kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // tiny per-IP rate limiter (OCR is the expensive route)
  const hits = new Map();
  const limit = (max, windowMs) => (req, res, next) => {
    const k = req.ip + req.path, now = Date.now();
    const a = (hits.get(k) || []).filter(t => now - t < windowMs);
    if (a.length >= max) return res.status(429).json({ error: 'Too many requests, try again shortly' });
    a.push(now); hits.set(k, a); next();
  };
  setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

  const parseCookies = h => Object.fromEntries((h || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
  const sessionUser = req => {
    const t = parseCookies(req.headers.cookie).sid; if (!t) return null;
    return db.prepare('SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(sha(t), Date.now()) || null;
  };
  // CSRF: cookies are SameSite=Lax, and every state-changing API call must carry a custom header
  // (browsers will not add it on cross-site form posts) and, when present, a same-origin Origin.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.get('x-requested-with') !== 'splitsnap') return res.status(403).json({ error: 'Bad request' });
      const o = req.get('origin'); if (o && new URL(o).host !== req.get('host')) return res.status(403).json({ error: 'Bad origin' });
    }
    req.user = sessionUser(req); next();
  });
  const needUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Please log in' });
  const setCookie = (res, tok, maxAge) => res.setHeader('Set-Cookie', `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
  const startSession = (res, uid) => {
    const tok = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(tok), uid, Date.now() + SESSION_MS);
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    setCookie(res, tok, SESSION_MS / 1000);
  };
  const emailOk = e => typeof e === 'string' && e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  app.post('/api/signup', limit(10, 60000), (req, res) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase(), pw = req.body.password;
      if (!emailOk(email)) throw new Error('Enter a valid email');
      if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) throw new Error('Password must be at least 8 characters');
      const name = String(req.body.name || '').trim().slice(0, 40); if (!name) throw new Error('Name is required');
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new Error('That email is already registered');
      const salt = crypto.randomBytes(16).toString('hex');
      const id = db.prepare('INSERT INTO users(email,name,pw_salt,pw_hash) VALUES(?,?,?,?)').run(email, name, salt, hashPw(pw, salt)).lastInsertRowid;
      startSession(res, id); res.status(201).json({ id, email, name });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/login', limit(10, 60000), (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(pw, u.pw_salt), 'hex'), Buffer.from(u.pw_hash, 'hex'));
    if (!ok) return res.status(401).json({ error: 'Wrong email or password' });
    startSession(res, u.id); res.json({ id: u.id, email: u.email, name: u.name });
  });
  app.post('/api/logout', (req, res) => {
    const t = parseCookies(req.headers.cookie).sid; if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(t));
    setCookie(res, '', 0); res.json({ ok: true });
  });
  app.get('/api/me', (req, res) => res.json(req.user || null));
  app.use(['/api/groups', '/api/ocr', '/api/parse-text'], needUser);

  const wrap = fn => (req, res) => { try { fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };
  const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };
  const str = (v, n = 80) => { v = typeof v === 'string' ? v.trim() : ''; if (!v) bad('Name is required'); return v.slice(0, n); };
  // Non-members get 404 so group ids cannot be probed.
  const gid = req => {
    const g = db.prepare('SELECT g.* FROM groups g JOIN members m ON m.group_id=g.id AND m.user_id=? WHERE g.id=?').get(req.user.id, +req.params.id);
    if (!g) bad('Group not found', 404); return g;
  };
  const myMember = (req, g) => db.prepare('SELECT id FROM members WHERE group_id=? AND user_id=?').get(g.id, req.user.id).id;
  const membersOf = id => db.prepare('SELECT id,name FROM members WHERE group_id=? ORDER BY id').all(id);

  app.get('/api/groups', wrap((req, res) => res.json(db.prepare('SELECT g.id,g.name,g.created_at FROM groups g JOIN members m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.id DESC').all(req.user.id))));
  app.post('/api/groups', wrap((req, res) => {
    const name = str(req.body.name);
    const names = [...new Set((req.body.members || []).map(m => str(m, 40)))].slice(0, 50);
    const id = db.transaction(() => {
      const gId = db.prepare('INSERT INTO groups(name,owner_id) VALUES(?,?)').run(name, req.user.id).lastInsertRowid;
      db.prepare('INSERT INTO members(group_id,user_id,name) VALUES(?,?,?)').run(gId, req.user.id, req.user.name);
      for (const n of names) if (n !== req.user.name) db.prepare('INSERT INTO members(group_id,name) VALUES(?,?)').run(gId, n);
      return gId;
    })();
    res.status(201).json({ id });
  }));
  app.delete('/api/groups/:id', wrap((req, res) => { if (gid(req).owner_id !== req.user.id) bad('Only the group owner can delete it', 403); db.prepare('DELETE FROM groups WHERE id=?').run(+req.params.id); res.json({ ok: true }); }));
  app.post('/api/groups/:id/members', wrap((req, res) => {
    const g = gid(req); let name, uid = null;
    if (req.body.email) {
      const u = db.prepare('SELECT id,name FROM users WHERE email=?').get(String(req.body.email).trim().toLowerCase());
      if (!u) bad('No SplitSnap account with that email. Ask them to sign up, or add them by name.');
      if (db.prepare('SELECT 1 FROM members WHERE group_id=? AND user_id=?').get(g.id, u.id)) bad('Already in this group');
      name = u.name; uid = u.id;
    } else name = str(req.body.name, 40);
    try { const r = db.prepare('INSERT INTO members(group_id,user_id,name) VALUES(?,?,?)').run(g.id, uid, name); res.status(201).json({ id: r.lastInsertRowid, name }); }
    catch (e) { bad('That name already exists in this group'); }
  }));

  function balances(groupId) {
    const net = new Map(membersOf(groupId).map(m => [m.id, 0]));
    for (const r of db.prepare('SELECT paid_by p, amount a FROM expenses WHERE group_id=?').all(groupId)) net.set(r.p, net.get(r.p) + r.a);
    for (const r of db.prepare('SELECT s.member_id m, s.share h FROM splits s JOIN expenses e ON e.id=s.expense_id WHERE e.group_id=?').all(groupId)) net.set(r.m, net.get(r.m) - r.h);
    for (const r of db.prepare('SELECT from_member f, to_member t, amount a FROM settlements WHERE group_id=?').all(groupId)) { net.set(r.f, net.get(r.f) + r.a); net.set(r.t, net.get(r.t) - r.a); }
    return net;
  }

  app.get('/api/groups/:id', wrap((req, res) => {
    const g = gid(req); const members = membersOf(g.id); const net = balances(g.id);
    const expenses = db.prepare('SELECT e.id,e.description,e.amount,e.paid_by,e.split_type,e.created_at FROM expenses e WHERE group_id=? ORDER BY e.id DESC LIMIT 200').all(g.id);
    const sp = db.prepare('SELECT member_id,share FROM splits WHERE expense_id=?');
    expenses.forEach(e => { e.splits = sp.all(e.id); });
    const settlements = db.prepare('SELECT id,from_member,to_member,amount,created_at FROM settlements WHERE group_id=? ORDER BY id DESC LIMIT 100').all(g.id);
    res.json({ me: myMember(req, g), group: { id: g.id, name: g.name, is_owner: g.owner_id === req.user.id }, members: members.map(m => ({ ...m, is_user: !!db.prepare('SELECT user_id FROM members WHERE id=?').get(m.id).user_id })), expenses, settlements,
      balances: members.map(m => ({ member_id: m.id, net: net.get(m.id) })), suggested: simplify(net) });
  }));

  app.post('/api/groups/:id/expenses', wrap((req, res) => {
    const g = gid(req); const b = req.body;
    const desc = str(b.description, 100); const amount = b.amount;
    const ids = new Set(membersOf(g.id).map(m => m.id));
    if (!ids.has(b.paid_by)) bad('Pick who paid');
    const shares = computeShares(b.split_type, amount, b.spec || {});
    if (shares.some(s => !ids.has(s.member_id))) bad('Unknown member in split');
    const id = db.transaction(() => {
      const eId = db.prepare('INSERT INTO expenses(group_id,description,amount,paid_by,split_type,note,created_by) VALUES(?,?,?,?,?,?,?)')
        .run(g.id, desc, amount, b.paid_by, b.split_type, typeof b.note === 'string' ? b.note.slice(0, 500) : null, req.user.id).lastInsertRowid;
      for (const s of shares) db.prepare('INSERT INTO splits VALUES(?,?,?)').run(eId, s.member_id, s.share);
      return eId;
    })();
    res.status(201).json({ id, shares });
  }));
  app.delete('/api/groups/:gid/expenses/:eid', wrap((req, res) => {
    req.params.id = req.params.gid; const g = gid(req);
    const r = db.prepare('DELETE FROM expenses WHERE id=? AND group_id=? AND (created_by=? OR ?=1)').run(+req.params.eid, g.id, req.user.id, g.owner_id === req.user.id ? 1 : 0);
    if (!r.changes) bad('Expense not found, or only its creator or the group owner can delete it', 404); res.json({ ok: true });
  }));

  app.post('/api/groups/:id/settlements', wrap((req, res) => {
    const g = gid(req); const { from_member: f, to_member: t, amount: a } = req.body;
    const ids = new Set(membersOf(g.id).map(m => m.id));
    if (!ids.has(f) || !ids.has(t) || f === t) bad('Pick two different members');
    if (!Number.isInteger(a) || a <= 0) bad('Amount must be more than 0');
    const id = db.prepare('INSERT INTO settlements(group_id,from_member,to_member,amount) VALUES(?,?,?,?)').run(g.id, f, t, a).lastInsertRowid;
    res.status(201).json({ id });
  }));
  app.delete('/api/groups/:gid/settlements/:sid', wrap((req, res) => {
    req.params.id = req.params.gid; const g = gid(req);
    const r = db.prepare('DELETE FROM settlements WHERE id=? AND group_id=?').run(+req.params.sid, g.id);
    if (!r.changes) bad('Not found', 404); res.json({ ok: true });
  }));

  // Bill photo -> editable draft. Nothing is saved until the user confirms.
  const tmp = path.join(__dirname, 'tmp'); fs.mkdirSync(tmp, { recursive: true });
  const upload = multer({ dest: tmp, limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (req, f, cb) => cb(/^image\/(jpeg|png|webp|bmp|gif)$/.test(f.mimetype) ? null : new Error('Upload a JPG, PNG or WebP image'), true) });
  app.post('/api/ocr', limit(20, 60000), (req, res) => {
    upload.single('bill')(req, res, async err => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'Attach an image as "bill"' });
      try {
        const text = await recognize(req.file.path);
        res.json({ ...parseBill(text), raw: text });
      } catch (e) { res.status(500).json({ error: 'Could not read that image' }); }
      finally { fs.unlink(req.file.path, () => {}); }
    });
  });
  app.post('/api/parse-text', wrap((req, res) => res.json(parseBill(String(req.body.text || '').slice(0, 20000)))));
  app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });
  return app;
}

if (require.main === module) {
  const db = open(process.env.DB_FILE || path.join(__dirname, 'splitsnap.db'));
  const port = +process.env.PORT || 3000;
  const server = createApp(db).listen(port, () => console.log(`SplitSnap on http://localhost:${port}`));
  const stop = () => server.close(() => { db.close(); process.exit(0); });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
module.exports = { createApp };
