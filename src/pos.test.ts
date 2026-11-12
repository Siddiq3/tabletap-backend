import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, readRestaurantPatch } from './app';
import { setBackendForTests } from './adapters';
import type { AuthProvider, NewOrder, Repos } from './ports';
import { DomainError, ERROR_MESSAGES, computeBillAmounts, makeBill, splitGst, type Bill, type Order } from './contract';

const RID = '11111111-1111-1111-1111-111111111111';
const OTHER = '99999999-9999-9999-9999-999999999999';
const T7 = '22222222-2222-2222-2222-222222222222';
const BILL = '33333333-3333-3333-3333-333333333333';
const ITEM = '55555555-5555-5555-5555-555555555555';
const DISH = '44444444-4444-4444-4444-444444444444';
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// Same inputs as db/tests/pos.sql: the TS mirror must give the database's numbers.
test('bill maths matches the database: discount, service charge, packaging, GST, round-off', () => {
  assert.deepEqual(
    computeBillAmounts({ subtotalPaise: 54000, discountPaise: 4000, kind: 'dine_in', serviceChargeOn: true, serviceChargePercent: 10, packagingPaise: 2000, taxPercent: 5 }),
    { subtotalPaise: 54000, discountPaise: 4000, serviceChargePaise: 5000, packagingPaise: 0, taxPaise: 2750, roundOffPaise: 50, totalPaise: 57800 },
  );
  assert.deepEqual(
    computeBillAmounts({ subtotalPaise: 18000, discountPaise: 0, kind: 'takeaway', serviceChargeOn: true, serviceChargePercent: 10, packagingPaise: 2000, taxPercent: 5 }),
    { subtotalPaise: 18000, discountPaise: 0, serviceChargePaise: 0, packagingPaise: 2000, taxPaise: 1000, roundOffPaise: 0, totalPaise: 21000 },
  );
  // T9 in the SQL test: 240 + 10% service = 264, GST 13.20 → 277.20 → 277.
  assert.equal(computeBillAmounts({ subtotalPaise: 24000, discountPaise: 0, kind: 'dine_in', serviceChargeOn: true, serviceChargePercent: 10, packagingPaise: 0, taxPercent: 5 }).totalPaise, 27700);
  // Discount never exceeds the subtotal; service waived; round-off can go down.
  const a = computeBillAmounts({ subtotalPaise: 10000, discountPaise: 99999, kind: 'dine_in', serviceChargeOn: false, serviceChargePercent: 10, packagingPaise: 0, taxPercent: 5 });
  assert.equal(a.discountPaise, 10000); assert.equal(a.totalPaise, 0);
  assert.deepEqual(computeBillAmounts({ subtotalPaise: 10040, discountPaise: 0, kind: 'dine_in', serviceChargeOn: false, serviceChargePercent: 0, packagingPaise: 0, taxPercent: 0 }), { subtotalPaise: 10040, discountPaise: 0, serviceChargePaise: 0, packagingPaise: 0, taxPaise: 0, roundOffPaise: -40, totalPaise: 10000 });
  assert.deepEqual(splitGst(2751), { cgstPaise: 1375, sgstPaise: 1376 });
});

function order(n: number, lines: Order['lines'], extra: Partial<Order> = {}): Order {
  const subtotalPaise = lines.reduce((s, l) => s + l.unitPricePaise * l.qty, 0);
  return { id: id(n), orderNo: 1000 + n, tableId: T7, tableLabel: 'T7', status: 'new', paymentStatus: 'unpaid', paymentMethod: null, note: null,
    subtotalPaise, taxPaise: 0, totalPaise: subtotalPaise, createdAt: `2026-11-12T19:0${n}:00Z`, lines, billId: BILL, ...extra };
}
const paneer = (qty: number) => ({ id: ITEM, name: 'Paneer tikka bowl', isVeg: true, unitPricePaise: 24000, qty });
const naan = (qty: number) => ({ name: 'Garlic naan', isVeg: true, unitPricePaise: 6000, qty });

function sampleBill(): Bill {
  const amounts = computeBillAmounts({ subtotalPaise: 54000, discountPaise: 4000, kind: 'dine_in', serviceChargeOn: true, serviceChargePercent: 10, packagingPaise: 0, taxPercent: 5 });
  return makeBill(
    { id: BILL, invoiceNo: 42, kind: 'dine_in', status: 'open', tableId: T7, tableLabel: 'T7', customerName: null, customerPhone: null, discountReason: 'Regular', serviceChargeOn: true, openedAt: '2026-11-12T19:00:00Z', settledAt: null, voidReason: null },
    amounts,
    [order(2, [paneer(1), naan(1)], { source: 'staff' }), order(1, [paneer(1)]), order(3, [naan(9)], { status: 'cancelled' })],
    [{ id: id(90), method: 'cash', amountPaise: 30000, createdAt: '2026-11-12T20:00:00Z' }],
  );
}

test('makeBill: rounds oldest first, cancelled left out, lines merged, GST split, balance due', () => {
  const b = sampleBill();
  assert.deepEqual(b.orders.map((o) => o.orderNo), [1001, 1002]);
  assert.deepEqual(b.lines, [{ name: 'Paneer tikka bowl', isVeg: true, unitPricePaise: 24000, qty: 2 }, { name: 'Garlic naan', isVeg: true, unitPricePaise: 6000, qty: 1 }]);
  assert.equal(b.cgstPaise + b.sgstPaise, b.taxPaise);
  assert.equal(b.paidPaise, 30000);
  assert.equal(b.duePaise, 57800 - 30000);
});

test('settings: GSTIN, FSSAI, service charge and packaging are validated', () => {
  assert.deepEqual(readRestaurantPatch({ gstin: ' 29abcde1234f1z5 ', fssai: '1234 5678 9012 34', serviceChargePercent: 7.5, packagingPaise: 2000 }),
    { gstin: '29ABCDE1234F1Z5', fssai: '12345678901234', serviceChargePercent: 7.5, packagingPaise: 2000 });
  assert.deepEqual(readRestaurantPatch({ gstin: '', fssai: '' }), { gstin: null, fssai: null });
  for (const bad of [{ gstin: '29ABCDE1234F1X5' }, { fssai: '123' }, { serviceChargePercent: 25 }, { packagingPaise: -1 }, { packagingPaise: 10.5 }]) {
    assert.throws(() => readRestaurantPatch(bad as never), JSON.stringify(bad));
  }
});

function setup() {
  const restaurant = { id: RID, name: 'Test', slug: 'test', plan: 'trial', taxPercent: 5, address: null, upiId: null };
  const calls: Record<string, unknown[][]> = {};
  const log = (k: string, ...a: unknown[]) => { (calls[k] ??= []).push(a); };
  const repos = {
    restaurants: {
      getBySlug: async () => restaurant,
      getMembership: async (user: string) => ({ role: user === 'other' ? 'owner' : user, restaurant: { ...restaurant, id: user === 'other' ? OTHER : RID } }),
      listTables: async () => [],
    },
    profiles: { get: async () => null },
    orders: {
      get: async (rid: string, oid: string) => (rid === RID && oid === id(1) ? order(1, [paneer(1)]) : null),
      place: async (input: NewOrder) => { log('place', input); return { orderId: id(50), orderNo: 1050, totalPaise: 25200, billId: BILL }; },
      cancelItem: async (...a: unknown[]) => { log('cancel', ...a); },
    },
    bills: {
      listOpen: async (rid: string) => (rid === RID ? [sampleBill()] : []),
      get: async (rid: string, bid: string) => (rid === RID && bid === BILL ? sampleBill() : null),
      openBillForOrder: async (rid: string, oid: string) => (rid === RID && oid === id(1) ? sampleBill() : null),
      pay: async (rid: string, bid: string, p: { expectedTotalPaise: number }, staff: string | null) => {
        if (p.expectedTotalPaise !== 57800) throw new DomainError('BILL_CHANGED', ERROR_MESSAGES.BILL_CHANGED);
        log('pay', rid, bid, p, staff);
      },
      update: async (rid: string, bid: string, patch: unknown) => { log('update', rid, bid, patch); return bid === BILL; },
      move: async (...a: unknown[]) => { log('move', ...a); },
      merge: async (...a: unknown[]) => { log('merge', ...a); },
      void: async (...a: unknown[]) => { log('void', ...a); },
      salesReport: async (...a: unknown[]) => { log('report', ...a); return { bills: 3 }; },
    },
  } as unknown as Repos;
  const roles = ['owner', 'other', 'manager', 'cashier', 'waiter', 'kitchen'];
  setBackendForTests(repos, { verify: async (t: string) => (roles.includes(t) ? t : null) } as AuthProvider);
  return calls;
}
const request = (path: string, method = 'GET', token?: string, data?: unknown) =>
  app.request(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', 'x-forwarded-for': 'pos-test' }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
const items = [{ menuItemId: DISH, qty: 2 }];

test('orders: guests are "qr"; staff add to a table, a bill or a new takeaway (exactly one); kitchen cannot', async () => {
  const calls = setup();
  assert.equal((await request('/public/orders', 'POST', undefined, { slug: 'test', tableId: T7, items })).status, 201);
  assert.equal((calls.place[0][0] as NewOrder).source, 'qr');
  assert.equal((await request('/staff/orders', 'POST', 'kitchen', { tableId: T7, items })).status, 403);
  assert.equal((await request('/staff/orders', 'POST', 'waiter', { items })).status, 400);
  assert.equal((await request('/staff/orders', 'POST', 'waiter', { tableId: T7, billId: BILL, items })).status, 400);
  assert.equal((await request('/staff/orders', 'POST', 'waiter', { takeaway: { customerPhone: 'call me' }, items })).status, 400);
  assert.equal((await request('/staff/orders', 'POST', 'waiter', { tableId: T7, items: [{ menuItemId: DISH, qty: 0 }] })).status, 400);
  for (const target of [{ tableId: T7 }, { billId: BILL }, { takeaway: { customerName: ' Asha ', customerPhone: '98765 43210' } }]) {
    const res = await request('/staff/orders', 'POST', 'waiter', { ...target, items, note: 'Less spicy' });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).billId, BILL);
  }
  const [toTable, toBill, takeaway] = calls.place.slice(1).map((c) => c[0] as NewOrder);
  assert.deepEqual([toTable.tableId, toTable.source, toTable.staffId, toTable.note], [T7, 'staff', null, 'Less spicy']);
  assert.equal(toBill.billId, BILL);
  assert.deepEqual(takeaway.takeaway, { customerName: 'Asha', customerPhone: '9876543210' });
});

test('bills: listing and reading are per restaurant; the guest sees their open bill only', async () => {
  setup();
  assert.equal((await request('/staff/bills', 'GET', 'kitchen')).status, 403);
  assert.equal((await (await request('/staff/bills', 'GET', 'waiter')).json()).bills[0].invoiceNo, 42);
  assert.equal((await (await request('/staff/bills', 'GET', 'other')).json()).bills.length, 0);
  assert.equal((await request(`/staff/bills/${BILL}`, 'GET', 'other')).status, 404);
  assert.equal((await request('/staff/bills/nope', 'GET', 'waiter')).status, 400);
  assert.equal((await (await request(`/public/r/test/orders/${id(1)}/bill`)).json()).bill.id, BILL);
  assert.equal((await request(`/public/r/test/orders/${id(2)}/bill`)).status, 404);
});

test('payments: cashiers and managers only, against the total they saw (split = several payments)', async () => {
  const calls = setup();
  const pay = { method: 'cash', amountPaise: 30000, expectedTotalPaise: 57800 };
  assert.equal((await request(`/staff/bills/${BILL}/payments`, 'POST', 'waiter', pay)).status, 403);
  assert.equal((await request(`/staff/bills/${BILL}/payments`, 'POST', 'cashier', { ...pay, method: 'cheque' })).status, 400);
  assert.equal((await request(`/staff/bills/${BILL}/payments`, 'POST', 'cashier', { ...pay, amountPaise: 0 })).status, 400);
  const stale = await request(`/staff/bills/${BILL}/payments`, 'POST', 'cashier', { ...pay, expectedTotalPaise: 50000 });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'BILL_CHANGED');
  const ok = await request(`/staff/bills/${BILL}/payments`, 'POST', 'cashier', pay);
  assert.equal(ok.status, 200); assert.equal((await ok.json()).bill.id, BILL);
  assert.equal(calls.pay.length, 1);
});

test('discounts, voids and item cancellations need a manager and a reason; moves and merges', async () => {
  const calls = setup();
  assert.equal((await request(`/staff/bills/${BILL}`, 'PATCH', 'cashier', { discountPaise: 5000, discountReason: 'Regular' })).status, 403);
  assert.equal((await request(`/staff/bills/${BILL}`, 'PATCH', 'manager', { discountPaise: 5000 })).status, 400);
  assert.equal((await request(`/staff/bills/${BILL}`, 'PATCH', 'manager', { discountPaise: 5000, discountReason: 'Regular' })).status, 200);
  assert.equal((await request(`/staff/bills/${BILL}`, 'PATCH', 'manager', { serviceChargeOn: false })).status, 200);
  assert.deepEqual(calls.update.map((c) => c[2]), [{ discountPaise: 5000, discountReason: 'Regular' }, { serviceChargeOn: false }]);

  assert.equal((await request(`/staff/bills/${BILL}/void`, 'POST', 'cashier', { reason: 'Walked out' })).status, 403);
  assert.equal((await request(`/staff/bills/${BILL}/void`, 'POST', 'manager', { reason: '' })).status, 400);
  assert.equal((await request(`/staff/bills/${BILL}/void`, 'POST', 'manager', { reason: 'Walked out' })).status, 204);

  assert.equal((await request(`/staff/order-items/${ITEM}/cancel`, 'POST', 'waiter', { qty: 1, reason: 'Out of stock' })).status, 403);
  assert.equal((await request(`/staff/order-items/${ITEM}/cancel`, 'POST', 'manager', { qty: 1 })).status, 400);
  assert.equal((await request(`/staff/order-items/${ITEM}/cancel`, 'POST', 'manager', { qty: 1, reason: 'Out of stock' })).status, 204);
  assert.deepEqual(calls.cancel[0], [RID, ITEM, 1, 'Out of stock', null]);

  assert.equal((await request(`/staff/bills/${BILL}/move`, 'POST', 'kitchen', { tableId: T7 })).status, 403);
  assert.equal((await request(`/staff/bills/${BILL}/move`, 'POST', 'waiter', { tableId: T7 })).status, 204);
  assert.equal((await request(`/staff/bills/${BILL}/merge`, 'POST', 'cashier', { intoBillId: BILL })).status, 400);
  assert.equal((await request(`/staff/bills/${BILL}/merge`, 'POST', 'cashier', { intoBillId: id(77) })).status, 204);
});

test('sales report: managers only, valid range of up to 3 months', async () => {
  const calls = setup();
  const q = '?from=2026-11-12T00:00:00%2B05:30&to=2026-11-13T00:00:00%2B05:30';
  assert.equal((await request(`/staff/reports/sales${q}`, 'GET', 'cashier')).status, 403);
  assert.equal((await request('/staff/reports/sales?from=x&to=y', 'GET', 'manager')).status, 400);
  assert.equal((await request('/staff/reports/sales?from=2026-01-01&to=2026-12-31', 'GET', 'manager')).status, 400);
  const res = await request(`/staff/reports/sales${q}`, 'GET', 'owner');
  assert.equal(res.status, 200); assert.equal((await res.json()).bills, 3);
  assert.deepEqual(calls.report[0], [RID, '2026-11-11T18:30:00.000Z', '2026-11-12T18:30:00.000Z']);
});
