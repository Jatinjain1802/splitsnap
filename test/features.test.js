const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { open } = require('../lib/db'); const { createApp } = require('../server');
function client(base) {
  let cookie = '';
  const call = async (p, m = 'GET', b, headers = {}) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'splitsnap', cookie, ...headers }, body: b && JSON.stringify(b) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { s: r.status, b: ct.includes('json') ? await r.json() : await r.text(), ct };
  };
  call.raw = async (p, o = {}) => fetch(base + p, { ...o, headers: { 'x-requested-with': 'splitsnap', cookie, ...(o.headers || {}) } });
  return call;
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
function setup(opts = {}) {
  const db = open(':memory:'); const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  const srv = createApp(db, { dataDir, appUrl: 'http://app.test', ...opts }).listen(0);
  return { db, srv, dataDir, base: `http://localhost:${srv.address().port}/api` };
}
const signup = (c, n) => c('/signup', 'POST', { email: n + '@x.io', name: n, password: 'password-' + n });

test('edit expense, receipt privacy, csv, totals', async t => {
  const { db, srv, base, dataDir } = setup(); t.after(() => { srv.close(); db.close(); });
  const A = client(base), B = client(base), C = client(base);
  await signup(A, 'asha'); await signup(B, 'bala'); await signup(C, 'chet');
  const { b: { id } } = await A('/groups', 'POST', { name: 'Trip', members: ['Ravi'] });
  await A(`/groups/${id}/members`, 'POST', { email: 'bala@x.io' });
  let g = (await A(`/groups/${id}`)).b; const [a, ravi, b] = g.members.map(m => m.id);
  const ex = await B(`/groups/${id}/expenses`, 'POST', { description: '=cmd', amount: 30000, paid_by: b, split_type: 'equal', spec: { members: [a, ravi, b] }, spent_on: '2026-11-20', category: 'food' });
  assert.equal(ex.s, 201);
  // edit: only creator (B) or owner (A); C is not a member
  assert.equal((await C(`/groups/${id}/expenses/${ex.b.id}`, 'PUT', {})).s, 404);
  const edit = await A(`/groups/${id}/expenses/${ex.b.id}`, 'PUT', { description: 'Dinner', amount: 60000, paid_by: b, split_type: 'exact', spec: { rows: [{ member_id: a, amount: 10000 }, { member_id: ravi, amount: 20000 }, { member_id: b, amount: 30000 }] }, category: 'food' });
  assert.equal(edit.s, 200);
  g = (await A(`/groups/${id}`)).b;
  assert.equal(g.currencies[0].balances.find(x => x.member_id === b).net, 30000);
  assert.equal(g.expenses[0].description, 'Dinner'); assert.ok(g.expenses[0].edited_at); assert.equal(g.currencies[0].spent, 60000);
  assert.equal((await A(`/groups/${id}/expenses/${ex.b.id}`, 'PUT', { description: 'x', amount: 100, paid_by: a, split_type: 'exact', spec: { rows: [] } })).s, 400);
  // receipt: member-only, real image only
  const up = async (cl, body, type = 'image/png') => { const fd = new FormData(); fd.append('receipt', new Blob([body], { type }), 'r.png'); return cl.raw(`/groups/${id}/expenses/${ex.b.id}/receipt`, { method: 'POST', body: fd }); };
  assert.equal((await up(C, PNG)).status, 404);
  assert.equal((await up(A, Buffer.from('<script>alert(1)</script>'))).status, 400);
  assert.equal((await up(A, PNG)).status, 201);
  const got = await A.raw(`/groups/${id}/expenses/${ex.b.id}/receipt`); assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png'); assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await C.raw(`/groups/${id}/expenses/${ex.b.id}/receipt`)).status, 404);
  assert.equal(fs.readdirSync(path.join(dataDir, 'receipts')).length, 1);
  // csv neutralises formulas
  const csv = (await A(`/groups/${id}/export.csv`)).b; assert.match(csv, /Dinner/); assert.equal((await C(`/groups/${id}/export.csv`)).s, 404);
  // delete removes the file
  assert.equal((await A(`/groups/${id}/expenses/${ex.b.id}`, 'DELETE')).s, 200);
  assert.equal(fs.readdirSync(path.join(dataDir, 'receipts')).length, 0);
});

test('guest claim: owner-only, single use, history kept', async t => {
  const { db, srv, base } = setup(); t.after(() => { srv.close(); db.close(); });
  const A = client(base), B = client(base), C = client(base);
  await signup(A, 'asha'); await signup(B, 'bala'); await signup(C, 'chet');
  const { b: { id } } = await A('/groups', 'POST', { name: 'Trip', members: ['Ravi'] });
  let g = (await A(`/groups/${id}`)).b; const [a, ravi] = g.members.map(m => m.id);
  await A(`/groups/${id}/expenses`, 'POST', { description: 'Cab', amount: 10000, paid_by: a, split_type: 'equal', spec: { members: [a, ravi] } });
  assert.equal((await B(`/groups/${id}/members/${ravi}/invite`, 'POST')).s, 404);
  assert.equal((await A(`/groups/${id}/members/${a}/invite`, 'POST')).s, 400); // already has account
  const inv = await A(`/groups/${id}/members/${ravi}/invite`, 'POST'); assert.equal(inv.s, 201);
  assert.equal((await B('/claim/preview', 'POST', { token: 'nope' })).s, 404);
  assert.deepEqual((await B('/claim/preview', 'POST', { token: inv.b.token })).b, { group: 'Trip', guest: 'Ravi' });
  assert.equal((await A('/claim', 'POST', { token: inv.b.token })).s, 400); // owner is already a member
  assert.equal((await B('/claim', 'POST', { token: inv.b.token })).s, 200);
  assert.equal((await C('/claim', 'POST', { token: inv.b.token })).s, 404); // single use
  g = (await B(`/groups/${id}`)).b; assert.equal(g.me, ravi); assert.equal(g.currencies[0].balances.find(x => x.member_id === ravi).net, -5000);
  assert.equal((await A('/claim', 'POST', { token: inv.b.token })).s, 404);
});

test('reset and verify are off without a mailer', async t => {
  const { db, srv, base } = setup({ mailer: null }); t.after(() => { srv.close(); db.close(); });
  const A = client(base); await signup(A, 'asha');
  assert.equal((await A('/password-reset/request', 'POST', { email: 'asha@x.io' })).s, 501);
  assert.equal((await A('/verify/request', 'POST')).s, 501);
  assert.equal((await A('/me')).b.email_enabled, false);
});

test('reset and verify tokens with a mailer: single use, expiry, sessions revoked', async t => {
  const sent = []; const mailer = { send: async (to, subject, text) => sent.push({ to, text }) };
  const { db, srv, base } = setup({ mailer }); t.after(() => { srv.close(); db.close(); });
  const A = client(base), X = client(base); await signup(A, 'asha');
  await new Promise(r => setTimeout(r, 50));
  const vt = sent.at(-1).text.match(/verify\/([a-f0-9]+)/)[1]; assert.equal((await A('/me')).b.email_verified, false);
  assert.equal((await X('/verify', 'POST', { token: vt })).s, 200); assert.equal((await A('/me')).b.email_verified, true);
  assert.equal((await X('/verify', 'POST', { token: vt })).s, 400);
  // unknown email gives the same answer and sends nothing
  const n = sent.length; assert.equal((await X('/password-reset/request', 'POST', { email: 'ghost@x.io' })).s, 200); assert.equal(sent.length, n);
  assert.equal((await X('/password-reset/request', 'POST', { email: 'asha@x.io' })).s, 200);
  const rt = sent.at(-1).text.match(/reset\/([a-f0-9]+)/)[1];
  assert.equal((await X('/password-reset/confirm', 'POST', { token: rt, password: 'short' })).s, 400);
  assert.equal((await X('/password-reset/confirm', 'POST', { token: rt, password: 'brand-new-pass' })).s, 200);
  assert.equal((await X('/password-reset/confirm', 'POST', { token: rt, password: 'another-pass-1' })).s, 400);
  assert.equal((await A('/me')).b, null); // old sessions revoked
  assert.equal((await X('/login', 'POST', { email: 'asha@x.io', password: 'password-asha' })).s, 401);
  assert.equal((await X('/login', 'POST', { email: 'asha@x.io', password: 'brand-new-pass' })).s, 200);
  db.prepare('UPDATE tokens SET expires_at=1').run(); // expired tokens are rejected
  assert.equal((await X('/password-reset/confirm', 'POST', { token: rt, password: 'x-another-pass' })).s, 400);
});
