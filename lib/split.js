'use strict';
// All money is integer paise. Largest-remainder rounding keeps sums exact.
function apportion(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw new Error('weights must sum to more than 0');
  const raw = weights.map(w => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length][1]]++;
  return out;
}

// Returns [{member_id, share}] summing exactly to amount.
function computeShares(type, amount, spec) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer (paise)');
  const merge = list => {
    const m = new Map();
    for (const [id, v] of list) m.set(id, (m.get(id) || 0) + v);
    return [...m].map(([member_id, share]) => ({ member_id, share })).filter(s => s.share > 0);
  };
  if (type === 'equal') {
    const ids = [...new Set(spec.members || [])];
    if (!ids.length) throw new Error('pick at least one member');
    const sh = apportion(amount, ids.map(() => 1));
    return merge(ids.map((id, i) => [id, sh[i]]));
  }
  if (type === 'exact') {
    const rows = spec.rows || [];
    const sum = rows.reduce((a, r) => a + r.amount, 0);
    if (rows.some(r => !Number.isInteger(r.amount) || r.amount < 0)) throw new Error('invalid exact amount');
    if (sum !== amount) throw new Error(`exact amounts add up to ${sum}, expected ${amount}`);
    return merge(rows.map(r => [r.member_id, r.amount]));
  }
  if (type === 'percent') {
    const rows = spec.rows || [];
    const total = Math.round(rows.reduce((a, r) => a + r.percent, 0) * 1000);
    if (total !== 100000) throw new Error('percentages must add up to 100');
    const sh = apportion(amount, rows.map(r => Math.round(r.percent * 1000)));
    return merge(rows.map((r, i) => [r.member_id, sh[i]]));
  }
  if (type === 'shares') {
    const rows = (spec.rows || []).filter(r => r.shares > 0);
    if (!rows.length) throw new Error('give at least one share');
    const sh = apportion(amount, rows.map(r => r.shares));
    return merge(rows.map((r, i) => [r.member_id, sh[i]]));
  }
  if (type === 'items') {
    // items: [{name, amount, members:[ids]}], amount is the bill total incl. tax/tip.
    const items = spec.items || [];
    if (!items.length) throw new Error('no items');
    const sub = items.reduce((a, it) => a + it.amount, 0);
    if (sub > amount) throw new Error('items add up to more than the total');
    const extra = amount - sub; // tax, tip, fees: spread in proportion to what each person ordered
    const per = new Map();
    for (const it of items) {
      const ids = [...new Set(it.members || [])];
      if (!ids.length) throw new Error(`assign "${it.name}" to someone`);
      const sh = apportion(it.amount, ids.map(() => 1));
      ids.forEach((id, i) => per.set(id, (per.get(id) || 0) + sh[i]));
    }
    const ids = [...per.keys()];
    const ex = extra && sub ? apportion(extra, ids.map(id => per.get(id))) : ids.map(() => 0);
    return merge(ids.map((id, i) => [id, per.get(id) + ex[i]]));
  }
  throw new Error('unknown split type');
}

// net: Map member_id -> paise (positive = is owed). Returns [{from,to,amount}] with few transfers.
function simplify(net) {
  const cr = [], de = [];
  for (const [id, v] of net) { if (v > 0) cr.push([id, v]); else if (v < 0) de.push([id, -v]); }
  cr.sort((a, b) => b[1] - a[1]); de.sort((a, b) => b[1] - a[1]);
  const out = []; let i = 0, j = 0;
  while (i < cr.length && j < de.length) {
    const a = Math.min(cr[i][1], de[j][1]);
    out.push({ from: de[j][0], to: cr[i][0], amount: a });
    cr[i][1] -= a; de[j][1] -= a;
    if (!cr[i][1]) i++; if (!de[j][1]) j++;
  }
  return out;
}
module.exports = { apportion, computeShares, simplify };
