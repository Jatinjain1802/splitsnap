const test = require('node:test'); const assert = require('node:assert');
const { open } = require('../lib/db'); const { createApp } = require('../server');
function client(base) {
  let cookie = '';
  return async (p, m = 'GET', b, headers = {}) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'splitsnap', cookie, ...headers }, body: b && JSON.stringify(b) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { s: r.status, b: await r.json() };
  };
}
test("auth, authorization, expenses, balances, settle-up", async t => {
  const db = open(':memory:'); const srv = createApp(db).listen(0); const base = `http://localhost:${srv.address().port}/api`; t.after(() => { srv.close(); db.close(); });
  const A = client(base), B = client(base), C = client(base);
  assert.equal((await A('/groups')).s, 401);
  assert.equal((await A('/signup', 'POST', { email: 'a@x.io', name: 'Asha', password: 'password1' })).s, 201);
  assert.equal((await B('/signup', 'POST', { email: 'b@x.io', name: 'Bala', password: 'password2' })).s, 201);
  assert.equal((await C('/signup', 'POST', { email: 'c@x.io', name: 'Chet', password: 'password3' })).s, 201);
  assert.equal((await A('/signup', 'POST', { email: 'a@x.io', name: 'x', password: 'password1' })).s, 400);
  assert.equal((await A('/login', 'POST', { email: 'a@x.io', password: 'wrongwrong' })).s, 401);
  // CSRF header required
  assert.equal((await A('/groups', 'POST', { name: 'x' }, { 'x-requested-with': '' })).s, 403);
  const { b: { id } } = await A('/groups', 'POST', { name: 'Goa', members: ['Guest Ravi'] });
  assert.equal((await B(`/groups/${id}`)).s, 404);               // not a member
  assert.equal((await A(`/groups/${id}/members`, 'POST', { email: 'nobody@x.io' })).s, 400);
  assert.equal((await A(`/groups/${id}/members`, 'POST', { email: 'b@x.io' })).s, 201);
  assert.equal((await C(`/groups/${id}/expenses`, 'POST', {})).s, 404);
  let g = (await A(`/groups/${id}`)).b; const [a, ravi, b] = g.members.map(m => m.id);
  assert.equal(g.me, a);
  assert.equal((await B(`/groups/${id}`)).s, 200);
  const ex = await A(`/groups/${id}/expenses`, 'POST', { description: 'Dinner', amount: 30000, paid_by: a, split_type: 'equal', spec: { members: [a, ravi, b] } });
  assert.equal(ex.s, 201);
  g = (await A(`/groups/${id}`)).b; assert.equal(g.balances.find(x => x.member_id === a).net, 20000);
  assert.equal((await B(`/groups/${id}/expenses/${ex.b.id}`, 'DELETE')).s, 404); // not creator/owner
  await B(`/groups/${id}/settlements`, 'POST', { from_member: b, to_member: a, amount: 10000 });
  g = (await A(`/groups/${id}`)).b; assert.equal(g.balances.find(x => x.member_id === b).net, 0);
  assert.equal((await A(`/groups/${id}/expenses`, 'POST', { description: 'x', amount: 100, paid_by: a, split_type: 'exact', spec: { rows: [{ member_id: a, amount: 5 }] } })).s, 400);
  assert.equal((await B(`/groups/${id}`, 'DELETE')).s, 403);
  assert.equal((await A(`/groups/${id}/expenses/${ex.b.id}`, 'DELETE')).s, 200);
  await A('/logout', 'POST'); assert.equal((await A('/groups')).s, 401);
  srv.close(); db.close();
});
