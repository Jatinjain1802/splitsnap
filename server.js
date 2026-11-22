'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { open } = require('./lib/db');
const { computeShares, simplify } = require('./lib/split');
const { parseBill, recognize } = require('./lib/ocr');
const { getMailer } = require('./lib/mailer');

const crypto = require('crypto');
const SESSION_MS = 30 * 24 * 3600 * 1000;
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

function createApp(db, opts = {}) {
  const mailer = opts.mailer !== undefined ? opts.mailer : getMailer();
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const receiptDir = path.join(dataDir, 'receipts');
  const appUrl = (opts.appUrl || process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
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
      startSession(res, id); if (mailer) sendVerify({ id, email }).catch(() => {}); res.status(201).json({ id, email, name });
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
  app.get('/api/me', (req, res) => res.json(req.user ? { ...req.user, email_verified: !!db.prepare('SELECT email_verified v FROM users WHERE id=?').get(req.user.id).v, email_enabled: !!mailer } : null));

  // Password reset and email verification. Disabled (501) unless a mailer is configured.
  const newToken = (uid, kind, ms) => { const t = crypto.randomBytes(32).toString('hex'); db.prepare('DELETE FROM tokens WHERE user_id=? AND kind=?').run(uid, kind); db.prepare('INSERT INTO tokens VALUES(?,?,?,?)').run(sha(t), uid, kind, Date.now() + ms); return t; };
  const useToken = (t, kind) => { const r = db.prepare('SELECT * FROM tokens WHERE token_hash=? AND kind=? AND expires_at>?').get(sha(String(t || '')), kind, Date.now()); if (r) db.prepare('DELETE FROM tokens WHERE token_hash=?').run(r.token_hash); return r; };
  const needMailer = (req, res, next) => mailer ? next() : res.status(501).json({ error: 'Email is not configured on this server, so password reset and email verification are turned off.' });
  const sendVerify = async u => { const t = newToken(u.id, 'verify', 24 * 3600 * 1000); await mailer.send(u.email, 'Verify your SplitSnap email', `Open this link within 24 hours:\n${appUrl}/#/verify/${t}\n`); };
  app.post('/api/password-reset/request', limit(5, 60000), needMailer, async (req, res) => {
    const u = db.prepare('SELECT id,email FROM users WHERE email=?').get(String(req.body.email || '').trim().toLowerCase());
    try { if (u) { const t = newToken(u.id, 'reset', 3600 * 1000); await mailer.send(u.email, 'Reset your SplitSnap password', `Open this link within 1 hour to choose a new password:\n${appUrl}/#/reset/${t}\nIf you did not ask for this, ignore this email.\n`); } } catch (e) { console.error('mail failed'); }
    res.json({ ok: true, message: 'If that email has an account, a reset link has been sent.' });
  });
  app.post('/api/password-reset/confirm', limit(10, 60000), (req, res) => {
    try {
      const pw = req.body.password; if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) throw new Error('Password must be at least 8 characters');
      const t = useToken(req.body.token, 'reset'); if (!t) throw new Error('This reset link is invalid or expired');
      const salt = crypto.randomBytes(16).toString('hex');
      db.transaction(() => { db.prepare('UPDATE users SET pw_salt=?,pw_hash=? WHERE id=?').run(salt, hashPw(pw, salt), t.user_id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(t.user_id); })();
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/verify/request', limit(5, 60000), needUser, needMailer, async (req, res) => {
    try { await sendVerify(req.user); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: 'Could not send email' }); }
  });
  app.post('/api/verify', limit(10, 60000), (req, res) => {
    const t = useToken(req.body.token, 'verify'); if (!t) return res.status(400).json({ error: 'This verification link is invalid or expired' });
    db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(t.user_id); res.json({ ok: true });
  });
  app.use(['/api/groups', '/api/ocr', '/api/parse-text', '/api/claim'], needUser);

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
    const g = gid(req); const members = db.prepare('SELECT id,name,user_id IS NOT NULL AS is_user FROM members WHERE group_id=? ORDER BY id').all(g.id); const net = balances(g.id);
    const expenses = db.prepare('SELECT id,description,amount,paid_by,split_type,spent_on,category,note,spec_json,receipt_file IS NOT NULL AS has_receipt,ocr_text IS NOT NULL AS has_ocr,created_by,edited_at,created_at FROM expenses WHERE group_id=? ORDER BY id DESC LIMIT 200').all(g.id);
    const sp = db.prepare('SELECT member_id,share FROM splits WHERE expense_id=?');
    expenses.forEach(e => { e.splits = sp.all(e.id); e.spec = e.spec_json ? JSON.parse(e.spec_json) : null; delete e.spec_json; e.can_edit = e.created_by === req.user.id || g.owner_id === req.user.id; delete e.created_by; e.has_receipt = !!e.has_receipt; e.has_ocr = !!e.has_ocr; });
    const settlements = db.prepare('SELECT id,from_member,to_member,amount,created_at FROM settlements WHERE group_id=? ORDER BY id DESC LIMIT 100').all(g.id);
    const paid = new Map(), owed = new Map();
    for (const r of db.prepare('SELECT paid_by p, SUM(amount) a FROM expenses WHERE group_id=? GROUP BY paid_by').all(g.id)) paid.set(r.p, r.a);
    for (const r of db.prepare('SELECT s.member_id m, SUM(s.share) a FROM splits s JOIN expenses e ON e.id=s.expense_id WHERE e.group_id=? GROUP BY s.member_id').all(g.id)) owed.set(r.m, r.a);
    res.json({ me: myMember(req, g), group: { id: g.id, name: g.name, is_owner: g.owner_id === req.user.id }, members: members.map(m => ({ ...m, is_user: !!m.is_user })), expenses, settlements,
      totals: { spent: [...paid.values()].reduce((a, b) => a + b, 0), per_member: members.map(m => ({ member_id: m.id, paid: paid.get(m.id) || 0, share: owed.get(m.id) || 0 })) },
      balances: members.map(m => ({ member_id: m.id, net: net.get(m.id) })), suggested: simplify(net) });
  }));
  app.put('/api/groups/:id', wrap((req, res) => {
    const g = gid(req); if (g.owner_id !== req.user.id) bad('Only the group owner can rename it', 403);
    db.prepare('UPDATE groups SET name=? WHERE id=?').run(str(req.body.name), g.id); res.json({ ok: true });
  }));

  const CATS = ['general', 'food', 'travel', 'stay', 'shopping', 'bills', 'fun', 'other'];
  function parseExpense(g, b) {
    const desc = str(b.description, 100); const amount = b.amount;
    const ids = new Set(membersOf(g.id).map(m => m.id));
    if (!ids.has(b.paid_by)) bad('Pick who paid');
    const shares = computeShares(b.split_type, amount, b.spec || {});
    if (shares.some(s => !ids.has(s.member_id))) bad('Unknown member in split');
    const spent_on = typeof b.spent_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.spent_on) && !isNaN(Date.parse(b.spent_on)) ? b.spent_on : null;
    const category = CATS.includes(b.category) ? b.category : 'general';
    return { desc, amount, paid_by: b.paid_by, split_type: b.split_type, shares, spent_on, category,
      note: typeof b.note === 'string' ? b.note.slice(0, 500) : null, spec_json: JSON.stringify(b.spec || {}),
      ocr_text: typeof b.ocr_text === 'string' && b.ocr_text ? b.ocr_text.slice(0, 20000) : null };
  }
  app.post('/api/groups/:id/expenses', wrap((req, res) => {
    const g = gid(req); const x = parseExpense(g, req.body);
    const id = db.transaction(() => {
      const eId = db.prepare('INSERT INTO expenses(group_id,description,amount,paid_by,split_type,note,created_by,spent_on,category,spec_json,ocr_text) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(g.id, x.desc, x.amount, x.paid_by, x.split_type, x.note, req.user.id, x.spent_on, x.category, x.spec_json, x.ocr_text).lastInsertRowid;
      for (const s of x.shares) db.prepare('INSERT INTO splits VALUES(?,?,?)').run(eId, s.member_id, s.share);
      return eId;
    })();
    res.status(201).json({ id, shares: x.shares });
  }));
  const ownExpense = (req, g) => {
    const e = db.prepare('SELECT * FROM expenses WHERE id=? AND group_id=?').get(+req.params.eid, g.id);
    if (!e || (e.created_by !== req.user.id && g.owner_id !== req.user.id)) bad('Expense not found, or only its creator or the group owner can change it', 404);
    return e;
  };
  app.put('/api/groups/:gid/expenses/:eid', wrap((req, res) => {
    req.params.id = req.params.gid; const g = gid(req); const e = ownExpense(req, g); const x = parseExpense(g, req.body);
    db.transaction(() => {
      db.prepare("UPDATE expenses SET description=?,amount=?,paid_by=?,split_type=?,note=?,spent_on=?,category=?,spec_json=?,ocr_text=COALESCE(?,ocr_text),edited_by=?,edited_at=datetime('now') WHERE id=?")
        .run(x.desc, x.amount, x.paid_by, x.split_type, x.note, x.spent_on, x.category, x.spec_json, x.ocr_text, req.user.id, e.id);
      db.prepare('DELETE FROM splits WHERE expense_id=?').run(e.id);
      for (const s of x.shares) db.prepare('INSERT INTO splits VALUES(?,?,?)').run(e.id, s.member_id, s.share);
    })();
    res.json({ ok: true, shares: x.shares });
  }));
  app.delete('/api/groups/:gid/expenses/:eid', wrap((req, res) => {
    req.params.id = req.params.gid; const g = gid(req); const e = ownExpense(req, g);
    db.prepare('DELETE FROM expenses WHERE id=?').run(e.id);
    if (e.receipt_file) fs.unlink(path.join(receiptDir, e.receipt_file), () => {});
    res.json({ ok: true });
  }));

  // Receipts: stored privately on disk, served only to group members through this route.
  const MAGIC = [[/^image\/jpeg$/, b => b[0] === 0xff && b[1] === 0xd8, 'jpg'], [/^image\/png$/, b => b.slice(1, 4).toString() === 'PNG', 'png'],
    [/^image\/webp$/, b => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP', 'webp'], [/^image\/gif$/, b => b.slice(0, 3).toString() === 'GIF', 'gif']];
  const rcpUpload = multer({ dest: path.join(dataDir, 'tmp'), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true }); fs.mkdirSync(receiptDir, { recursive: true });
  app.post('/api/groups/:gid/expenses/:eid/receipt', limit(30, 60000), (req, res) => {
    rcpUpload.single('receipt')(req, res, err => {
      const drop = () => req.file && fs.unlink(req.file.path, () => {});
      try {
        if (err) bad(err.message); if (!req.file) bad('Attach an image as "receipt"');
        req.params.id = req.params.gid; const g = gid(req); const e = ownExpense(req, g);
        const head = Buffer.alloc(12); const fd = fs.openSync(req.file.path, 'r'); fs.readSync(fd, head, 0, 12, 0); fs.closeSync(fd);
        const m = MAGIC.find(([re, ok]) => re.test(req.file.mimetype) && ok(head)); if (!m) bad('Receipt must be a JPG, PNG, WebP or GIF image');
        const name = crypto.randomBytes(16).toString('hex') + '.' + m[2];
        fs.renameSync(req.file.path, path.join(receiptDir, name));
        if (e.receipt_file) fs.unlink(path.join(receiptDir, e.receipt_file), () => {});
        db.prepare('UPDATE expenses SET receipt_file=?, receipt_mime=? WHERE id=?').run(name, req.file.mimetype, e.id);
        res.status(201).json({ ok: true });
      } catch (e2) { drop(); res.status(e2.status || 400).json({ error: e2.message }); }
    });
  });
  app.get('/api/groups/:gid/expenses/:eid/receipt', wrap((req, res) => {
    req.params.id = req.params.gid; const g = gid(req);
    const e = db.prepare('SELECT receipt_file,receipt_mime FROM expenses WHERE id=? AND group_id=?').get(+req.params.eid, g.id);
    if (!e || !e.receipt_file) bad('No receipt', 404);
    res.set({ 'Content-Type': e.receipt_mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'" });
    res.sendFile(path.join(receiptDir, e.receipt_file));
  }));
  app.delete('/api/groups/:gid/expenses/:eid/receipt', wrap((req, res) => {
    req.params.id = req.params.gid; const g = gid(req); const e = ownExpense(req, g);
    if (e.receipt_file) fs.unlink(path.join(receiptDir, e.receipt_file), () => {});
    db.prepare('UPDATE expenses SET receipt_file=NULL, receipt_mime=NULL WHERE id=?').run(e.id); res.json({ ok: true });
  }));
  app.get('/api/groups/:id/export.csv', wrap((req, res) => {
    const g = gid(req); const names = new Map(membersOf(g.id).map(m => [m.id, m.name]));
    const cell = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
    const rows = [['date', 'description', 'category', 'amount', 'paid_by', 'split_type', 'shares']];
    for (const e of db.prepare('SELECT * FROM expenses WHERE group_id=? ORDER BY id').all(g.id)) {
      const sh = db.prepare('SELECT member_id,share FROM splits WHERE expense_id=?').all(e.id).map(s => `${names.get(s.member_id)}=${(s.share / 100).toFixed(2)}`).join('; ');
      rows.push([e.spent_on || String(e.created_at).slice(0, 10), e.description, e.category, (e.amount / 100).toFixed(2), names.get(e.paid_by), e.split_type, sh]);
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="splitsnap-export.csv"' }); res.send(rows.map(r => r.map(cell).join(',')).join('\n') + '\n');
  }));

  // Guest -> account claim. The owner makes a one-time link for a named guest; whoever logs in and
  // confirms it becomes that member (history is kept). The link is a secret: share it only with that person.
  const hashTok = t => sha(String(t));
  app.post('/api/groups/:id/members/:mid/invite', wrap((req, res) => {
    const g = gid(req); if (g.owner_id !== req.user.id) bad('Only the group owner can make invite links', 403);
    const m = db.prepare('SELECT id,user_id FROM members WHERE id=? AND group_id=?').get(+req.params.mid, g.id);
    if (!m) bad('Member not found', 404); if (m.user_id) bad('That member already has an account');
    db.prepare('DELETE FROM invites WHERE member_id=?').run(m.id);
    const tok = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO invites VALUES(?,?,?,?)').run(hashTok(tok), g.id, m.id, Date.now() + 7 * 24 * 3600 * 1000);
    res.status(201).json({ token: tok, expires_in_days: 7 });
  }));
  const findInvite = tok => db.prepare('SELECT i.*, g.name gname, m.name mname, m.user_id muid FROM invites i JOIN groups g ON g.id=i.group_id JOIN members m ON m.id=i.member_id WHERE i.token_hash=? AND i.expires_at>?').get(hashTok(tok), Date.now());
  app.post('/api/claim/preview', limit(20, 60000), wrap((req, res) => {
    const i = findInvite(req.body.token); if (!i || i.muid) bad('This invite link is invalid, expired or already used', 404);
    res.json({ group: i.gname, guest: i.mname });
  }));
  app.post('/api/claim', limit(20, 60000), wrap((req, res) => {
    const i = findInvite(req.body.token); if (!i || i.muid) bad('This invite link is invalid, expired or already used', 404);
    if (db.prepare('SELECT 1 FROM members WHERE group_id=? AND user_id=?').get(i.group_id, req.user.id)) bad('You are already a member of this group');
    db.transaction(() => { db.prepare('UPDATE members SET user_id=? WHERE id=? AND user_id IS NULL').run(req.user.id, i.member_id); db.prepare('DELETE FROM invites WHERE member_id=?').run(i.member_id); })();
    res.json({ group_id: i.group_id });
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
