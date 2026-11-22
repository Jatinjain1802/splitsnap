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
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test('currencies stay separate, no conversion', async t => {
  const { db, srv, base } = setup(); t.after(() => { srv.close(); db.close(); });
  const A = client(base), B = client(base);
  await signup(A, 'asha'); await signup(B, 'bala');
  const { b: { id } } = await A('/groups', 'POST', { name: 'Trip', members: [] });
  await A(`/groups/${id}/members`, 'POST', { email: 'bala@x.io' });
  let g = (await A(`/groups/${id}`)).b; const [a, b] = g.members.map(m => m.id);
  assert.equal(g.currencies.length, 1); assert.equal(g.currencies[0].currency, 'INR');
  await A(`/groups/${id}/expenses`, 'POST', { description: 'Dinner', amount: 30000, paid_by: a, split_type: 'equal', spec: { members: [a, b] } });
  const usd = await B(`/groups/${id}/expenses`, 'POST', { description: 'Museum', amount: 2000, paid_by: b, split_type: 'equal', spec: { members: [a, b] }, currency: 'usd' });
  assert.equal(usd.s, 201);
  g = (await A(`/groups/${id}`)).b;
  assert.deepEqual(g.currencies.map(c => c.currency), ['INR', 'USD']);
  const inr = g.currencies.find(c => c.currency === 'INR'), us = g.currencies.find(c => c.currency === 'USD');
  assert.equal(inr.spent, 30000); assert.equal(us.spent, 2000);
  assert.equal(inr.balances.find(x => x.member_id === a).net, 15000);
  assert.equal(us.balances.find(x => x.member_id === a).net, -1000);
  assert.equal(us.balances.find(x => x.member_id === b).net, 1000);
  assert.equal(us.suggested.length, 1); assert.equal(us.suggested[0].amount, 1000);
  // a USD settlement only moves USD balances
  await A(`/groups/${id}/settlements`, 'POST', { from_member: a, to_member: b, amount: 1000, currency: 'USD' });
  g = (await A(`/groups/${id}`)).b;
  assert.equal(g.currencies.find(c => c.currency === 'USD').balances.every(x => x.net === 0), true);
  assert.equal(g.currencies.find(c => c.currency === 'INR').balances.find(x => x.member_id === a).net, 15000);
  // expenses expose their currency and the CSV has the column
  assert.equal(g.expenses.find(e => e.description === 'Museum').currency, 'USD');
  const csv = (await A(`/groups/${id}/export.csv`)).b;
  assert.match(csv.split('\n')[0], /currency/); assert.match(csv, /Museum","general","USD/);
  // editing can change currency
  const e2 = g.expenses.find(e => e.description === 'Museum');
  assert.equal((await B(`/groups/${id}/expenses/${e2.id}`, 'PUT', { description: 'Museum', amount: 2000, paid_by: b, split_type: 'equal', spec: { members: [a, b] }, currency: 'EUR' })).s, 200);
  g = (await A(`/groups/${id}`)).b;
  assert.ok(g.currencies.find(c => c.currency === 'EUR'));
  // junk currency falls back to INR
  assert.equal((await A(`/groups/${id}/expenses`, 'POST', { description: 'x', amount: 100, paid_by: a, split_type: 'equal', spec: { members: [a] }, currency: '$$$' })).s, 201);
  g = (await A(`/groups/${id}`)).b;
  assert.equal(g.expenses[0].currency, 'INR');
});

test('recurring expenses materialize once and can be stopped', async t => {
  const { db, srv, base } = setup(); t.after(() => { srv.close(); db.close(); });
  const A = client(base), B = client(base);
  await signup(A, 'asha'); await signup(B, 'bala');
  const { b: { id } } = await A('/groups', 'POST', { name: 'Flat', members: [] });
  await A(`/groups/${id}/members`, 'POST', { email: 'bala@x.io' });
  let g = (await A(`/groups/${id}`)).b; const [a, b] = g.members.map(m => m.id);
  const r = await A(`/groups/${id}/recurring`, 'POST', { description: 'Rent', amount: 600000, paid_by: a, split_type: 'equal', spec: { members: [a, b] }, freq: 'weekly', spent_on: today() });
  assert.equal(r.s, 201); assert.equal(r.b.next_due, plusDays(7));
  g = (await A(`/groups/${id}`)).b;
  assert.equal(g.recurring.length, 1); assert.equal(g.recurring[0].freq, 'weekly');
  assert.equal(g.expenses.length, 1); // first occurrence saved immediately
  // push the rule into the past: three weekly occurrences come due
  db.prepare('UPDATE recurring SET next_due=?').run(plusDays(-15));
  g = (await A(`/groups/${id}`)).b;
  assert.equal(g.expenses.length, 4);
  assert.equal(g.recurring[0].next_due, plusDays(6));
  const rent = g.expenses.filter(e => e.description === 'Rent');
  assert.equal(rent.length, 4);
  for (const e of rent) assert.equal(e.splits.reduce((x, s) => x + s.share, 0), 600000);
  assert.equal(g.currencies[0].balances.find(x => x.member_id === a).net, 4 * 300000);
  // idempotent: another read adds nothing
  g = (await A(`/groups/${id}`)).b; assert.equal(g.expenses.length, 4);
  // monthly clamps to the end of a short month
  const m = await A(`/groups/${id}/recurring`, 'POST', { description: 'Cleaner', amount: 20000, paid_by: a, split_type: 'equal', spec: { members: [a, b] }, freq: 'monthly', spent_on: '2026-01-31' });
  assert.equal(m.b.next_due, '2026-02-28');
  // only creator or owner can stop a rule
  assert.equal((await B(`/groups/${id}/recurring/${r.b.id}`, 'DELETE')).s, 403);
  assert.equal((await A(`/groups/${id}/recurring/${r.b.id}`, 'DELETE')).s, 200);
  g = (await A(`/groups/${id}`)).b; assert.equal(g.recurring.length, 1);
});

test('in-app notifications: others are told, actor is not, read marks them', async t => {
  const { db, srv, base } = setup(); t.after(() => { srv.close(); db.close(); });
  const A = client(base), B = client(base);
  await signup(A, 'asha'); await signup(B, 'bala');
  const { b: { id } } = await A('/groups', 'POST', { name: 'Trip', members: ['Guest'] });
  await A(`/groups/${id}/members`, 'POST', { email: 'bala@x.io' });
  let g = (await A(`/groups/${id}`)).b; const [a, , b] = g.members.map(m => m.id);
  const before = (await B('/notifications')).b.unread;
  await A(`/groups/${id}/expenses`, 'POST', { description: 'Dinner', amount: 30000, paid_by: a, split_type: 'equal', spec: { members: [a, b] } });
  const nb = (await B('/notifications')).b;
  assert.equal(nb.unread, before + 1);
  assert.match(nb.items[0].text, /added "Dinner"/); assert.match(nb.items[0].text, /300\.00 INR/);
  // the actor is not notified about their own action
  const na = (await A('/notifications')).b;
  assert.equal(na.items.filter(i => i.text.includes('Dinner')).length, 0);
  // settlement notifies the other side
  await B(`/groups/${id}/settlements`, 'POST', { from_member: b, to_member: a, amount: 5000 });
  assert.match((await A('/notifications')).b.items[0].text, /payment of 50\.00 INR/);
  // guests have no account: nothing breaks, nothing is stored for them
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n, 2 + before);
  // marking read clears the badge
  assert.equal((await B('/notifications/read', 'POST')).s, 200);
  assert.equal((await B('/notifications')).b.unread, 0);
  assert.equal((await B('/notifications')).b.items[0].read, true);
});

test('deleting a group removes its receipt files', async t => {
  const { db, srv, base, dataDir } = setup(); t.after(() => { srv.close(); db.close(); });
  const A = client(base); await signup(A, 'asha');
  const { b: { id } } = await A('/groups', 'POST', { name: 'Trip', members: [] });
  const g = (await A(`/groups/${id}`)).b; const a = g.members[0].id;
  const ex = await A(`/groups/${id}/expenses`, 'POST', { description: 'Cab', amount: 10000, paid_by: a, split_type: 'equal', spec: { members: [a] } });
  const fd = new FormData(); fd.append('receipt', new Blob([PNG], { type: 'image/png' }), 'r.png');
  assert.equal((await A.raw(`/groups/${id}/expenses/${ex.b.id}/receipt`, { method: 'POST', body: fd })).status, 201);
  assert.equal(fs.readdirSync(path.join(dataDir, 'receipts')).length, 1);
  assert.equal((await A(`/groups/${id}`, 'DELETE')).s, 200);
  assert.equal(fs.readdirSync(path.join(dataDir, 'receipts')).length, 0);
});
