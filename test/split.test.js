const test = require('node:test'); const assert = require('node:assert');
const { computeShares, simplify } = require('../lib/split');
const { parseBill } = require('../lib/ocr');
const sum = s => s.reduce((a, x) => a + x.share, 0);
test('equal split keeps total exact', () => { const s = computeShares('equal', 10000, { members: [1, 2, 3] }); assert.equal(sum(s), 10000); assert.deepEqual(s.map(x => x.share).sort(), [3333, 3333, 3334]); });
test('percent', () => assert.equal(sum(computeShares('percent', 999, { rows: [{ member_id: 1, percent: 33.3 }, { member_id: 2, percent: 66.7 }] })), 999));
test('percent must be 100', () => assert.throws(() => computeShares('percent', 100, { rows: [{ member_id: 1, percent: 50 }] })));
test('exact mismatch rejected', () => assert.throws(() => computeShares('exact', 100, { rows: [{ member_id: 1, amount: 50 }] })));
test('shares', () => assert.deepEqual(computeShares('shares', 900, { rows: [{ member_id: 1, shares: 1 }, { member_id: 2, shares: 2 }] }).map(x => x.share), [300, 600]));
test('items spread tax proportionally', () => {
  const s = computeShares('items', 11000, { items: [{ name: 'a', amount: 6000, members: [1] }, { name: 'b', amount: 4000, members: [2] }] });
  assert.deepEqual(s.map(x => x.share), [6600, 4400]);
});
test('simplify settles everything', () => {
  const t = simplify(new Map([[1, 300], [2, -100], [3, -200]]));
  assert.equal(t.length, 2); assert.equal(t.reduce((a, x) => a + x.amount, 0), 300);
});
test('parseBill', () => {
  const b = parseBill('Spice Hut\nPaneer Tikka 250.00\nNaan x2 80.00\nSubtotal 330.00\nGST 5% 16.50\nGrand Total 346.50');
  assert.equal(b.items.length, 2); assert.equal(b.subtotal, 33000); assert.equal(b.tax, 1650); assert.equal(b.total, 34650); assert.equal(b.merchant, 'Spice Hut');
});
