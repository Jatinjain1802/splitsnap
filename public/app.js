'use strict';
const $app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (p, c) => (p < 0 ? '-' : '') + (c && c !== 'INR' ? c + ' ' : '₹') + (Math.abs(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const paise = v => Math.round(parseFloat(String(v).replace(/,/g, '')) * 100);
const toast = m => { const t = document.getElementById('toast'); t.textContent = m; t.style.display = 'block'; setTimeout(() => t.style.display = 'none', 3000); };
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'x-requested-with': 'splitsnap', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Something went wrong'); return d;
}
const CATS = ['general', 'food', 'travel', 'stay', 'shopping', 'bills', 'fun', 'other'];
const today = () => new Date().toISOString().slice(0, 10);
async function upload(path, file) {
  const fd = new FormData(); fd.append('receipt', file);
  const r = await fetch('/api' + path, { method: 'POST', headers: { 'x-requested-with': 'splitsnap' }, body: fd });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Upload failed');
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

async function authScreen() {
  $app.innerHTML = `<div class="card"><h2 id="at">Log in</h2><div class="row" id="nr" style="display:none"><input id="un" placeholder="Your name"></div>
  <div class="row"><input id="ue" type="email" placeholder="Email" autocomplete="username"></div>
  <div class="row"><input id="up" type="password" placeholder="Password (8+ characters)" autocomplete="current-password"></div>
  <div class="row"><button id="ab">Log in</button><button class="sec" id="sw">Create an account instead</button></div>
  <div class="row"><a href="#" id="fp" class="muted">Forgot password?</a></div></div>`;
  fp.onclick = guard(async e => { e.preventDefault(); if (!ue.value) throw new Error('Type your email first'); const r = await api('/password-reset/request', 'POST', { email: ue.value }); toast(r.message); });
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
   <div>${d.members.map(m => `<span class="pill">${esc(m.name)}${m.is_user ? '' : ' (guest)'}${m.id === d.me ? ' (you)' : ''}${!m.is_user && d.group.is_owner ? ` <a href="#" data-inv="${m.id}">invite link</a>` : ''}</span>`).join('')}</div>
   <div class="row"><input id="nm" placeholder="Friend's email (they have an account) or just a name"><button class="sec" id="am">Add</button></div></div>
   <div class="card"><h3>Balances</h3><p class="muted"><a href="/api/groups/${id}/export.csv">Download CSV</a>${d.group.is_owner ? ' · <a href="#" id="rn">Rename group</a>' : ''}</p>
   ${d.currencies.map(cc => `<h4 style="margin:.6em 0 .2em">${cc.currency} · total spent ${money(cc.spent, cc.currency)}</h4>${cc.balances.map(b => `<div class="row"><span style="flex:1">${name(b.member_id)}</span><span class="${b.net >= 0 ? 'pos' : 'neg'}">${b.net > 0 ? 'gets back ' : b.net < 0 ? 'owes ' : 'settled '}${b.net ? money(Math.abs(b.net), cc.currency) : ''}</span></div>`).join('')}
   <h4 style="margin:.6em 0 .2em">Settle up (${cc.currency})</h4>${cc.suggested.map(s => `<div class="row"><span style="flex:1">${name(s.from)} pays ${name(s.to)} <b>${money(s.amount, cc.currency)}</b></span><button class="sec" data-f="${s.from}" data-t="${s.to}" data-a="${s.amount}" data-c="${cc.currency}">Mark paid</button></div>`).join('') || '<p class="muted">All settled.</p>'}`).join('')}</div>
   ${d.recurring.length ? `<div class="card"><h3>Repeating expenses</h3>${d.recurring.map(r => `<div class="item"><div class="row"><span style="flex:1"><b>${esc(r.description)}</b> ${money(r.amount, r.currency)} · ${r.freq} · next ${esc(r.next_due)}<br><span class="muted">${esc(r.payer_name)} pays</span></span>${r.can_stop ? `<button class="del" data-rec="${r.id}">Stop</button>` : ''}</div></div>`).join('')}</div>` : ''}
   <div class="card"><h3>Add expense</h3><div class="tabs row"><button id="t1" class="on">Manual</button><button id="t2">Scan bill</button></div><div id="form"></div></div>
   <div class="card"><h3>History</h3>${d.expenses.map(e => `<div class="item"><div class="row"><span style="flex:1"><b>${esc(e.description)}</b> ${money(e.amount, e.currency)}<br><span class="muted">${name(e.paid_by)} paid · ${e.split_type} · ${esc(e.spent_on || e.created_at.slice(0, 10))} · ${esc(e.category || 'general')}${e.edited_at ? ' · edited' : ''}</span>
     ${e.has_receipt ? `<br><a href="/api/groups/${id}/expenses/${e.id}/receipt" target="_blank" rel="noopener">View receipt</a>` : ''}${e.can_edit ? ` <a href="#" data-edit="${e.id}">Edit</a> <a href="#" data-rcp="${e.id}">${e.has_receipt ? 'Replace' : 'Attach'} receipt</a>` : ''}</span><button class="del" data-e="${e.id}">✕</button></div></div>`).join('')}
   ${d.settlements.map(s => `<div class="item"><div class="row"><span style="flex:1" class="muted">${name(s.from_member)} paid ${name(s.to_member)} ${money(s.amount, s.currency)}</span><button class="del" data-s="${s.id}">✕</button></div></div>`).join('')}
   ${d.expenses.length + d.settlements.length ? '' : '<p class="muted">Nothing yet.</p>'}${d.group.is_owner ? '<button class="del" id="dg">Delete group</button>' : ''}</div>`;
  document.getElementById('am').onclick = guard(async () => { const v = document.getElementById('nm').value.trim(); await api(`/groups/${id}/members`, 'POST', v.includes('@') ? { email: v } : { name: v }); group(id); });
  $app.querySelectorAll('[data-f]').forEach(b => b.onclick = guard(async () => { await api(`/groups/${id}/settlements`, 'POST', { from_member: +b.dataset.f, to_member: +b.dataset.t, amount: +b.dataset.a, currency: b.dataset.c }); group(id); }));
  $app.querySelectorAll('[data-rec]').forEach(b => b.onclick = guard(async () => { if (confirm('Stop this repeating expense? Ones already added stay.')) { await api(`/groups/${id}/recurring/${b.dataset.rec}`, 'DELETE'); group(id); } }));
  $app.querySelectorAll('[data-e]').forEach(b => b.onclick = guard(async () => { if (confirm('Delete expense?')) { await api(`/groups/${id}/expenses/${b.dataset.e}`, 'DELETE'); group(id); } }));
  $app.querySelectorAll('[data-s]').forEach(b => b.onclick = guard(async () => { await api(`/groups/${id}/settlements/${b.dataset.s}`, 'DELETE'); group(id); }));
  if (d.group.is_owner) document.getElementById('dg').onclick = guard(async () => { if (confirm('Delete this group and everything in it?')) { await api('/groups/' + id, 'DELETE'); location.hash = '#/'; } });
  const done = () => group(id);
  const show = scan => { t1.className = scan ? '' : 'on'; t2.className = scan ? 'on' : ''; scan ? scanForm(d, id, done) : manualForm(d, id, done); };
  t1.onclick = () => show(false); t2.onclick = () => show(true); show(false);
  const rn = document.getElementById('rn');
  if (rn) rn.onclick = guard(async e => { e.preventDefault(); const n = prompt('New group name', d.group.name); if (n) { await api('/groups/' + id, 'PUT', { name: n }); done(); } });
  $app.querySelectorAll('[data-inv]').forEach(a => a.onclick = guard(async e => {
    e.preventDefault(); const r = await api(`/groups/${id}/members/${a.dataset.inv}/invite`, 'POST');
    prompt('One-time link, valid 7 days. Send it only to that person. Whoever opens it and logs in becomes this guest.', `${location.origin}/#/claim/${r.token}`);
  }));
  $app.querySelectorAll('[data-edit]').forEach(a => a.onclick = guard(async e => {
    e.preventDefault(); const ex = d.expenses.find(x => x.id === +a.dataset.edit); document.getElementById('form').scrollIntoView();
    t1.className = 'on'; t2.className = '';
    if (ex.split_type === 'items') billEditor(document.getElementById('form'), { items: ex.spec.items.map(i => ({ name: i.name, amount: i.amount, who: i.members })), total: ex.amount, merchant: ex.description }, d, id, done, ex);
    else manualForm(d, id, done, ex);
  }));
  $app.querySelectorAll('[data-rcp]').forEach(a => a.onclick = e => {
    e.preventDefault(); const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = guard(async () => { await upload(`/groups/${id}/expenses/${a.dataset.rcp}/receipt`, inp.files[0]); toast('Receipt saved'); done(); }); inp.click();
  });
}

function payerSelect(d) { return `<select id="pb">${d.members.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>`; }

function catSelect(v) { return `<select id="cat">${CATS.map(c => `<option ${c === (v || 'general') ? 'selected' : ''}>${c}</option>`).join('')}</select>`; }

function manualForm(d, id, done, ex) {
  const f = document.getElementById('form');
  f.innerHTML = `${ex ? `<p class="warn">Editing "${esc(ex.description)}"</p>` : ''}<div class="row"><input id="ds" placeholder="What for?" value="${ex ? esc(ex.description) : ''}"><input id="am2" type="number" step="0.01" min="0" placeholder="Amount ₹" style="max-width:130px" value="${ex ? (ex.amount / 100).toFixed(2) : ''}"></div>
  <div class="row"><span>Paid by</span>${payerSelect(d)}<span>Split</span><select id="st"><option value="equal">Equally</option><option value="exact">Exact amounts</option><option value="percent">Percentages</option><option value="shares">Shares</option></select></div>
  <div class="row"><input id="dt" type="date" value="${ex && ex.spent_on || today()}" style="max-width:160px">${catSelect(ex && ex.category)}<input id="cur" maxlength="3" style="max-width:70px" value="${ex ? esc(ex.currency || 'INR') : 'INR'}" title="Currency code, e.g. INR or USD"></div>
  <div id="sp"></div>${ex ? '' : `<div class="row"><label class="muted"><input type="checkbox" id="rc"> repeats</label><select id="rcf"><option value="weekly">every week</option><option value="monthly">every month</option></select></div>`}<button id="sv">${ex ? 'Save changes' : 'Save expense'}</button>${ex ? ' <button class="sec" id="cx">Cancel</button>' : ''}`;
  const sp = document.getElementById('sp'), st = document.getElementById('st');
  if (ex) { document.getElementById('pb').value = ex.paid_by; st.value = ex.split_type; if (ex.split_type === 'items') st.value = 'equal'; document.getElementById('cx').onclick = done; }
  const prefill = () => {
    if (!ex || ex.split_type !== st.value) return;
    const sh = ex.spec || {};
    sp.querySelectorAll('[data-m]').forEach(e => {
      const m = +e.dataset.m;
      if (st.value === 'equal') e.checked = (sh.members || []).includes(m);
      else { const r = (sh.rows || []).find(x => x.member_id === m); e.value = r ? (st.value === 'exact' ? (r.amount / 100).toFixed(2) : st.value === 'percent' ? r.percent : r.shares) : (st.value === 'shares' ? 0 : ''); }
    });
  };
  const draw = () => {
    const t = st.value;
    sp.innerHTML = d.members.map(m => t === 'equal' ? `<label class="pill"><input type="checkbox" data-m="${m.id}" checked> ${esc(m.name)}</label>`
      : `<div class="row"><span style="flex:1">${esc(m.name)}</span><input type="number" step="0.01" min="0" data-m="${m.id}" style="max-width:110px" placeholder="${t === 'exact' ? '₹' : t === 'percent' ? '%' : 'shares'}" value="${t === 'shares' ? 1 : ''}"></div>`).join('');
    prefill();
  };
  st.onchange = draw; draw();
  document.getElementById('sv').onclick = guard(async () => {
    const t = st.value, amount = paise(document.getElementById('am2').value); if (!(amount > 0)) throw new Error('Enter an amount');
    const els = [...sp.querySelectorAll('[data-m]')]; let spec;
    if (t === 'equal') spec = { members: els.filter(e => e.checked).map(e => +e.dataset.m) };
    else { const rows = els.filter(e => +e.value > 0).map(e => ({ member_id: +e.dataset.m, ...(t === 'exact' ? { amount: paise(e.value) } : t === 'percent' ? { percent: +e.value } : { shares: +e.value }) })); spec = { rows }; }
    const body = { description: document.getElementById('ds').value, amount, paid_by: +document.getElementById('pb').value, split_type: t, spec, spent_on: document.getElementById('dt').value, category: document.getElementById('cat').value, currency: document.getElementById('cur').value };
    const rc = document.getElementById('rc');
    if (ex) await api(`/groups/${id}/expenses/${ex.id}`, 'PUT', body);
    else if (rc && rc.checked) await api(`/groups/${id}/recurring`, 'POST', { ...body, freq: document.getElementById('rcf').value });
    else await api(`/groups/${id}/expenses`, 'POST', body);
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
    billEditor(out, bill, d, id, done, null, file);
  });
}

function billEditor(out, bill, d, id, done, ex, file) {
  const items = bill.items.length ? bill.items.map(i => ({ ...i, who: new Set(i.who || d.members.map(m => m.id)) })) : [{ name: '', amount: 0, who: new Set(d.members.map(m => m.id)) }];
  let extra = (bill.total || 0) - items.reduce((a, i) => a + i.amount, 0);
  const render = () => {
    out.innerHTML = `${bill.warning ? `<div class="warn">${esc(bill.warning)}</div>` : ''}
    <div class="row"><input id="bn" placeholder="Description" value="${esc(bill.merchant || 'Bill')}"><span>Paid by</span>${payerSelect(d)}</div>
    ${items.map((it, n) => `<div class="item"><div class="row"><input data-n="${n}" data-k="name" value="${esc(it.name)}" placeholder="Item"><input data-n="${n}" data-k="amount" type="number" step="0.01" value="${(it.amount / 100).toFixed(2)}" style="max-width:110px"><button class="del" data-rm="${n}">✕</button></div>
      <div>${d.members.map(m => `<label class="pill"><input type="checkbox" data-n="${n}" data-w="${m.id}" ${it.who.has(m.id) ? 'checked' : ''}> ${esc(m.name)}</label>`).join('')}</div></div>`).join('')}
    <div class="row"><button class="sec" id="ai">+ Item</button><span style="flex:1"></span><span>Tax/tip/fees ₹</span><input id="ex" type="number" step="0.01" value="${(extra / 100).toFixed(2)}" style="max-width:100px"></div>
    <p><b>Total ${money(items.reduce((a, i) => a + i.amount, 0) + extra, out.querySelector('#bcur') && bcur.value)}</b> <span class="muted">(tax and fees are shared in proportion to what each person ordered)</span></p><div class="row"><input id="bd" type="date" value="${ex && ex.spent_on || today()}" style="max-width:160px">${catSelect(ex ? ex.category : 'food')}<input id="bcur" maxlength="3" style="max-width:70px" value="${ex ? esc(ex.currency || 'INR') : 'INR'}" title="Currency code, e.g. INR or USD"></div>${file ? `<label class="muted"><input type="checkbox" id="keep" checked> Keep the bill photo with this expense (only group members can open it)</label><br>` : ''}<button id="sb">${ex ? 'Save changes' : 'Save split'}</button>${ex ? ' <button class="sec" id="cx">Cancel</button>' : ''}`;
    if (ex) { document.getElementById('pb').value = ex.paid_by; document.getElementById('cx').onclick = done; }
    out.querySelectorAll('input[data-k]').forEach(e => e.onchange = () => { const it = items[+e.dataset.n]; it[e.dataset.k] = e.dataset.k === 'amount' ? (paise(e.value) || 0) : e.value; if (e.dataset.k === 'amount') render(); });
    out.querySelectorAll('input[data-w]').forEach(e => e.onchange = () => { const s = items[+e.dataset.n].who; e.checked ? s.add(+e.dataset.w) : s.delete(+e.dataset.w); });
    out.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { items.splice(+b.dataset.rm, 1); render(); });
    document.getElementById('ex').onchange = e => { extra = paise(e.target.value) || 0; render(); };
    document.getElementById('ai').onclick = () => { items.push({ name: '', amount: 0, who: new Set(d.members.map(m => m.id)) }); render(); };
    document.getElementById('sb').onclick = guard(async () => {
      const total = items.reduce((a, i) => a + i.amount, 0) + extra;
      const body = { description: document.getElementById('bn').value, amount: total, paid_by: +document.getElementById('pb').value, split_type: 'items', spent_on: document.getElementById('bd').value, category: document.getElementById('cat').value, currency: document.getElementById('bcur').value,
        spec: { items: items.filter(i => i.amount > 0).map(i => ({ name: i.name || 'Item', amount: i.amount, members: [...i.who] })) }, ocr_text: bill.raw || undefined };
      if (ex) await api(`/groups/${id}/expenses/${ex.id}`, 'PUT', body);
      else {
        const r = await api(`/groups/${id}/expenses`, 'POST', body);
        const keep = document.getElementById('keep');
        if (file && keep && keep.checked) { try { await upload(`/groups/${id}/expenses/${r.id}/receipt`, file); } catch (e) { toast('Expense saved, but the photo was not: ' + e.message); await new Promise(r2 => setTimeout(r2, 1500)); } }
      }
      done();
    });
  };
  render();
}

async function notifsScreen() {
  const n = await api('/notifications');
  $app.innerHTML = `<div class="card"><h2>Notifications</h2><p class="muted">In-app only. No emails or push messages are sent.</p>${n.items.map(i => `<div class="item"><span class="${i.read ? 'muted' : ''}">${esc(i.text)}<br><span class="muted">${esc(i.created_at)}${i.group_id ? ` · <a href="#/g/${i.group_id}">open group</a>` : ''}</span></span></div>`).join('') || '<p class="muted">Nothing yet.</p>'}</div>`;
  await api('/notifications/read', 'POST');
}

async function route() {
  const me = await api('/me').catch(() => null);
  let bell = '';
  if (me) { const n = await api('/notifications').catch(() => null); if (n) bell = ` <a href="#/notifs" title="Notifications" style="font-weight:400;font-size:14px">${n.unread ? `Alerts <b style="background:#fff;color:#1f9d73;border-radius:99px;padding:0 7px">${n.unread}</b>` : 'Alerts'}</a>`; }
  document.getElementById('who').innerHTML = me ? `${esc(me.name)}${me.email_enabled && !me.email_verified ? ' <a href="#" id="vr" style="font-weight:400;font-size:14px">Verify email</a>' : ''}${bell} <a href="#/" id="lo" style="font-weight:400;font-size:14px">Log out</a>` : '';
  const pre = location.hash.match(/^#\/(reset|verify)\/([a-f0-9]+)/);
  if (pre) return pre[1] === 'reset' ? resetScreen(pre[2]) : verifyScreen(pre[2]);
  if (!me) return authScreen();
  if (document.getElementById('vr')) document.getElementById('vr').onclick = guard(async e => { e.preventDefault(); await api('/verify/request', 'POST'); toast('Verification email sent'); });
  document.getElementById('lo').onclick = guard(async e => { e.preventDefault(); await api('/logout', 'POST'); route(); });
  const t = location.hash.match(/^#\/(reset|verify|claim)\/([a-f0-9]+)/); const m = location.hash.match(/^#\/g\/(\d+)/);
  try { await (t && t[1] === 'claim' ? claimScreen(t[2]) : location.hash === '#/notifs' ? notifsScreen() : m ? group(+m[1]) : home()); } catch (e) { toast(e.message); location.hash = '#/'; }
}
window.addEventListener('hashchange', route); route();

async function resetScreen(token) {
  $app.innerHTML = `<div class="card"><h2>Choose a new password</h2><div class="row"><input id="np" type="password" placeholder="New password (8+ characters)"></div><button id="rb">Save password</button></div>`;
  rb.onclick = guard(async () => { await api('/password-reset/confirm', 'POST', { token, password: np.value }); toast('Password changed. Log in with it.'); location.hash = '#/'; });
}
async function verifyScreen(token) {
  $app.innerHTML = '<div class="card"><h2>Verifying…</h2></div>';
  try { await api('/verify', 'POST', { token }); $app.innerHTML = '<div class="card"><h2>Email verified</h2><a href="#/">Continue</a></div>'; }
  catch (e) { $app.innerHTML = `<div class="card"><h2>${esc(e.message)}</h2><a href="#/">Back</a></div>`; }
}
async function claimScreen(token) {
  const p = await api('/claim/preview', 'POST', { token });
  $app.innerHTML = `<div class="card"><h2>Join "${esc(p.group)}"</h2><p>You will take over the guest <b>${esc(p.guest)}</b>, including their expenses and balance, and see everything in this group. Only continue if this link was meant for you.</p><button id="cb">Yes, that is me</button> <a href="#/">Cancel</a></div>`;
  cb.onclick = guard(async () => { const r = await api('/claim', 'POST', { token }); location.hash = '#/g/' + r.group_id; });
}
