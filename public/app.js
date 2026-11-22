'use strict';
const $app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = p => (p < 0 ? '-' : '') + '₹' + (Math.abs(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const paise = v => Math.round(parseFloat(String(v).replace(/,/g, '')) * 100);
const toast = m => { const t = document.getElementById('toast'); t.textContent = m; t.style.display = 'block'; setTimeout(() => t.style.display = 'none', 3000); };
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'x-requested-with': 'splitsnap', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Something went wrong'); return d;
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

async function authScreen() {
  $app.innerHTML = `<div class="card"><h2 id="at">Log in</h2><div class="row" id="nr" style="display:none"><input id="un" placeholder="Your name"></div>
  <div class="row"><input id="ue" type="email" placeholder="Email" autocomplete="username"></div>
  <div class="row"><input id="up" type="password" placeholder="Password (8+ characters)" autocomplete="current-password"></div>
  <div class="row"><button id="ab">Log in</button><button class="sec" id="sw">Create an account instead</button></div></div>`;
  let signup = false;
  sw.onclick = () => { signup = !signup; nr.style.display = signup ? 'flex' : 'none'; at.textContent = signup ? 'Sign up' : 'Log in'; ab.textContent = at.textContent; sw.textContent = signup ? 'I have an account' : 'Create an account instead'; };
  ab.onclick = guard(async () => { await api(signup ? '/signup' : '/login', 'POST', { name: un.value, email: ue.value, password: up.value }); await route(); });
}

async function home() {
  const groups = await api('/groups');
  $app.innerHTML = `<div class="card"><h2>New group</h2><div class="row"><input id="gn" placeholder="Group name (Goa trip)"></div>
  <div class="row"><input id="gm" placeholder="Friends, comma separated (Amit, Ravi)"></div><button id="mk">Create group</button></div>
  <div class="card"><h2>Your groups</h2>${groups.map(g => `<div class="row"><a href="#/g/${g.id}">${esc(g.name)}</a></div>`).join('') || '<p class="muted">No groups yet.</p>'}</div>`;
  document.getElementById('mk').onclick = guard(async () => {
    const members = document.getElementById('gm').value.split(',').map(s => s.trim()).filter(Boolean);
    const { id } = await api('/groups', 'POST', { name: document.getElementById('gn').value, members }); location.hash = '#/g/' + id;
  });
}

async function group(id) {
  const d = await api('/groups/' + id); const name = m => esc((d.members.find(x => x.id === m) || {}).name || '?');
  $app.innerHTML = `<div class="card"><h2>${esc(d.group.name)}</h2>
   <div>${d.members.map(m => `<span class="pill">${esc(m.name)}${m.is_user ? '' : ' (guest)'}${m.id === d.me ? ' (you)' : ''}</span>`).join('')}</div>
   <div class="row"><input id="nm" placeholder="Friend's email (they have an account) or just a name"><button class="sec" id="am">Add</button></div></div>
   <div class="card"><h3>Balances</h3>${d.balances.map(b => `<div class="row"><span style="flex:1">${name(b.member_id)}</span><span class="${b.net >= 0 ? 'pos' : 'neg'}">${b.net > 0 ? 'gets back ' : b.net < 0 ? 'owes ' : 'settled '}${b.net ? money(Math.abs(b.net)) : ''}</span></div>`).join('')}
   <h3>Settle up</h3>${d.suggested.map(s => `<div class="row"><span style="flex:1">${name(s.from)} pays ${name(s.to)} <b>${money(s.amount)}</b></span><button class="sec" data-f="${s.from}" data-t="${s.to}" data-a="${s.amount}">Mark paid</button></div>`).join('') || '<p class="muted">All settled.</p>'}</div>
   <div class="card"><h3>Add expense</h3><div class="tabs row"><button id="t1" class="on">Manual</button><button id="t2">Scan bill</button></div><div id="form"></div></div>
   <div class="card"><h3>History</h3>${d.expenses.map(e => `<div class="item"><div class="row"><span style="flex:1"><b>${esc(e.description)}</b> ${money(e.amount)}<br><span class="muted">${name(e.paid_by)} paid · ${e.split_type}</span></span><button class="del" data-e="${e.id}">✕</button></div></div>`).join('')}
   ${d.settlements.map(s => `<div class="item"><div class="row"><span style="flex:1" class="muted">${name(s.from_member)} paid ${name(s.to_member)} ${money(s.amount)}</span><button class="del" data-s="${s.id}">✕</button></div></div>`).join('')}
   ${d.expenses.length + d.settlements.length ? '' : '<p class="muted">Nothing yet.</p>'}${d.group.is_owner ? '<button class="del" id="dg">Delete group</button>' : ''}</div>`;
  document.getElementById('am').onclick = guard(async () => { const v = document.getElementById('nm').value.trim(); await api(`/groups/${id}/members`, 'POST', v.includes('@') ? { email: v } : { name: v }); group(id); });
  $app.querySelectorAll('[data-f]').forEach(b => b.onclick = guard(async () => { await api(`/groups/${id}/settlements`, 'POST', { from_member: +b.dataset.f, to_member: +b.dataset.t, amount: +b.dataset.a }); group(id); }));
  $app.querySelectorAll('[data-e]').forEach(b => b.onclick = guard(async () => { if (confirm('Delete expense?')) { await api(`/groups/${id}/expenses/${b.dataset.e}`, 'DELETE'); group(id); } }));
  $app.querySelectorAll('[data-s]').forEach(b => b.onclick = guard(async () => { await api(`/groups/${id}/settlements/${b.dataset.s}`, 'DELETE'); group(id); }));
  if (d.group.is_owner) document.getElementById('dg').onclick = guard(async () => { if (confirm('Delete this group and everything in it?')) { await api('/groups/' + id, 'DELETE'); location.hash = '#/'; } });
  const done = () => group(id);
  const show = scan => { t1.className = scan ? '' : 'on'; t2.className = scan ? 'on' : ''; scan ? scanForm(d, id, done) : manualForm(d, id, done); };
  t1.onclick = () => show(false); t2.onclick = () => show(true); show(false);
}

function payerSelect(d) { return `<select id="pb">${d.members.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>`; }

function manualForm(d, id, done) {
  const f = document.getElementById('form');
  f.innerHTML = `<div class="row"><input id="ds" placeholder="What for?"><input id="am2" type="number" step="0.01" min="0" placeholder="Amount ₹" style="max-width:130px"></div>
  <div class="row"><span>Paid by</span>${payerSelect(d)}<span>Split</span><select id="st"><option value="equal">Equally</option><option value="exact">Exact amounts</option><option value="percent">Percentages</option><option value="shares">Shares</option></select></div>
  <div id="sp"></div><button id="sv">Save expense</button>`;
  const sp = document.getElementById('sp'), st = document.getElementById('st');
  const draw = () => {
    const t = st.value;
    sp.innerHTML = d.members.map(m => t === 'equal' ? `<label class="pill"><input type="checkbox" data-m="${m.id}" checked> ${esc(m.name)}</label>`
      : `<div class="row"><span style="flex:1">${esc(m.name)}</span><input type="number" step="0.01" min="0" data-m="${m.id}" style="max-width:110px" placeholder="${t === 'exact' ? '₹' : t === 'percent' ? '%' : 'shares'}" value="${t === 'shares' ? 1 : ''}"></div>`).join('');
  };
  st.onchange = draw; draw();
  document.getElementById('sv').onclick = guard(async () => {
    const t = st.value, amount = paise(document.getElementById('am2').value); if (!(amount > 0)) throw new Error('Enter an amount');
    const els = [...sp.querySelectorAll('[data-m]')]; let spec;
    if (t === 'equal') spec = { members: els.filter(e => e.checked).map(e => +e.dataset.m) };
    else { const rows = els.filter(e => +e.value > 0).map(e => ({ member_id: +e.dataset.m, ...(t === 'exact' ? { amount: paise(e.value) } : t === 'percent' ? { percent: +e.value } : { shares: +e.value }) })); spec = { rows }; }
    await api(`/groups/${id}/expenses`, 'POST', { description: document.getElementById('ds').value, amount, paid_by: +document.getElementById('pb').value, split_type: t, spec });
    done();
  });
}

function scanForm(d, id, done) {
  const f = document.getElementById('form');
  f.innerHTML = `<p class="muted">Upload a bill photo. Text is read on the server, then you can fix anything before saving.</p>
  <div class="row"><input type="file" id="fl" accept="image/*"><button id="go">Read bill</button></div><div id="out"></div>`;
  document.getElementById('go').onclick = guard(async () => {
    const file = document.getElementById('fl').files[0]; if (!file) throw new Error('Choose a photo first');
    const out = document.getElementById('out'); out.innerHTML = '<p class="muted">Reading bill… can take 10-30 seconds.</p>';
    const fd = new FormData(); fd.append('bill', file);
    const r = await fetch('/api/ocr', { method: 'POST', headers: { 'x-requested-with': 'splitsnap' }, body: fd }); const bill = await r.json();
    if (!r.ok) { out.innerHTML = ''; throw new Error(bill.error); }
    billEditor(out, bill, d, id, done);
  });
}

function billEditor(out, bill, d, id, done) {
  const items = bill.items.length ? bill.items.map(i => ({ ...i, who: new Set(d.members.map(m => m.id)) })) : [{ name: '', amount: 0, who: new Set(d.members.map(m => m.id)) }];
  let extra = (bill.total || 0) - items.reduce((a, i) => a + i.amount, 0);
  const render = () => {
    out.innerHTML = `${bill.warning ? `<div class="warn">${esc(bill.warning)}</div>` : ''}
    <div class="row"><input id="bn" placeholder="Description" value="${esc(bill.merchant || 'Bill')}"><span>Paid by</span>${payerSelect(d)}</div>
    ${items.map((it, n) => `<div class="item"><div class="row"><input data-n="${n}" data-k="name" value="${esc(it.name)}" placeholder="Item"><input data-n="${n}" data-k="amount" type="number" step="0.01" value="${(it.amount / 100).toFixed(2)}" style="max-width:110px"><button class="del" data-rm="${n}">✕</button></div>
      <div>${d.members.map(m => `<label class="pill"><input type="checkbox" data-n="${n}" data-w="${m.id}" ${it.who.has(m.id) ? 'checked' : ''}> ${esc(m.name)}</label>`).join('')}</div></div>`).join('')}
    <div class="row"><button class="sec" id="ai">+ Item</button><span style="flex:1"></span><span>Tax/tip/fees ₹</span><input id="ex" type="number" step="0.01" value="${(extra / 100).toFixed(2)}" style="max-width:100px"></div>
    <p><b>Total ${money(items.reduce((a, i) => a + i.amount, 0) + extra)}</b> <span class="muted">(tax and fees are shared in proportion to what each person ordered)</span></p><button id="sb">Save split</button>`;
    out.querySelectorAll('input[data-k]').forEach(e => e.onchange = () => { const it = items[+e.dataset.n]; it[e.dataset.k] = e.dataset.k === 'amount' ? (paise(e.value) || 0) : e.value; if (e.dataset.k === 'amount') render(); });
    out.querySelectorAll('input[data-w]').forEach(e => e.onchange = () => { const s = items[+e.dataset.n].who; e.checked ? s.add(+e.dataset.w) : s.delete(+e.dataset.w); });
    out.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { items.splice(+b.dataset.rm, 1); render(); });
    document.getElementById('ex').onchange = e => { extra = paise(e.target.value) || 0; render(); };
    document.getElementById('ai').onclick = () => { items.push({ name: '', amount: 0, who: new Set(d.members.map(m => m.id)) }); render(); };
    document.getElementById('sb').onclick = guard(async () => {
      const total = items.reduce((a, i) => a + i.amount, 0) + extra;
      await api(`/groups/${id}/expenses`, 'POST', { description: document.getElementById('bn').value, amount: total, paid_by: +document.getElementById('pb').value, split_type: 'items',
        spec: { items: items.filter(i => i.amount > 0).map(i => ({ name: i.name || 'Item', amount: i.amount, members: [...i.who] })) } });
      done();
    });
  };
  render();
}

async function route() {
  const me = await api('/me').catch(() => null);
  document.getElementById('who').innerHTML = me ? `${esc(me.name)} <a href="#/" id="lo" style="font-weight:400;font-size:14px">Log out</a>` : '';
  if (!me) return authScreen();
  document.getElementById('lo').onclick = guard(async e => { e.preventDefault(); await api('/logout', 'POST'); route(); });
  const m = location.hash.match(/^#\/g\/(\d+)/); try { await (m ? group(+m[1]) : home()); } catch (e) { toast(e.message); location.hash = '#/'; }
}
window.addEventListener('hashchange', route); route();
