'use strict';
// Bill text -> {merchant, items, subtotal, tax, total}. Amounts in paise.
const AMT = /(?:rs\.?|inr|₹|\$)?\s*(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})|\d+\.\d{1,2}|\d{1,6})\s*$/i;
const toPaise = s => Math.round(parseFloat(String(s).replace(/,/g, '')) * 100);
const TOTAL = /\b(grand\s*total|net\s*(amount|payable|total)|amount\s*(due|payable)|total\s*(amount|due|payable)?|bill\s*amount|balance\s*due)\b/i;
const SUBTOT = /\b(sub\s*-?\s*total)\b/i;
const TAX = /\b(gst|cgst|sgst|igst|vat|tax|service\s*(charge|tax)|cess)\b/i;
const SKIP = /\b(invoice|bill\s*no|table|date|time|phone|ph\b|tel|gstin|fssai|cashier|order|token|thank|visit|round\s*off|change|cash|card|upi|paid|qty|rate|amount|particulars|item)\b/i;
const DISC = /\b(discount|coupon|promo|saving)\b/i;

function parseBill(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/[|_]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const items = []; let subtotal = null, tax = 0, total = null, discount = 0, merchant = '';
  for (const line of lines) {
    if (!merchant && /[A-Za-z]{3,}/.test(line) && !/\d{4,}/.test(line) && !SKIP.test(line)) merchant = line.slice(0, 60);
    const m = line.match(AMT);
    if (!m) continue;
    const label = line.slice(0, m.index).replace(/[\s:.\-x*]+$/i, '').trim();
    const val = toPaise(m[1]);
    if (!(val > 0) && val !== 0) continue;
    if (SUBTOT.test(line)) { subtotal = val; continue; }
    if (TAX.test(line) && !TOTAL.test(line)) { tax += val; continue; }
    if (TOTAL.test(line)) { total = Math.max(total || 0, val); continue; }
    if (DISC.test(line)) { discount += val; continue; }
    if (SKIP.test(line) || label.length < 2 || !/[A-Za-z]{2,}/.test(label)) continue;
    // "2 x Naan 120.00" or "Naan 2 120.00": keep line total, qty in the name
    items.push({ name: label.replace(/^\d+\s*[x×]?\s+/i, m2 => m2.trim() + ' ').slice(0, 60), amount: val });
  }
  const itemSum = items.reduce((a, i) => a + i.amount, 0);
  if (subtotal == null) subtotal = itemSum;
  if (total == null) total = subtotal + tax - discount;
  return { merchant, items, subtotal, tax, discount, total, itemSum, warning: itemSum && subtotal && itemSum !== subtotal ? 'Items do not add up to the subtotal on the bill. Please check the amounts.' : null };
}

let workerP;
async function recognize(path) {
  const { createWorker } = require('tesseract.js');
  workerP = workerP || createWorker('eng');
  const w = await workerP;
  const { data } = await w.recognize(path);
  return data.text;
}
module.exports = { parseBill, recognize, toPaise };
