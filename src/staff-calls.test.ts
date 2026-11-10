import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from './app';
import { setBackendForTests } from './adapters';
import type { AuthProvider, Repos } from './ports';
import type { StaffCall } from './contract';
const RID = '11111111-1111-1111-1111-111111111111';
const OTHER = '99999999-9999-9999-9999-999999999999';
const TABLE = '22222222-2222-2222-2222-222222222222';
const ID = '33333333-3333-3333-3333-333333333333';
function setup() {
  let rows: (StaffCall & { rid: string })[] = [];
  const restaurant = { id: RID, name: 'Test', slug: 'test', plan: 'trial', taxPercent: 5, address: null, upiId: null };
  const repos = {
    restaurants: {
      getBySlug: async (slug: string) => slug === 'test' ? restaurant : slug === 'suspended' ? { ...restaurant, plan: 'suspended' } : null,
      getMembership: async (user: string) => ({ role: user === 'waiter' ? 'waiter' : 'owner', restaurant: { ...restaurant, id: user === 'other' ? OTHER : RID } }),
      getTable: async (rid: string, id: string) => rid === RID && id === TABLE ? { id, label: '7', isActive: true, seats: 4 } : null,
    },
    profiles: { get: async () => null },
    staffCalls: {
      request: async (rid: string, tableId: string) => {
        const found = rows.find(r => r.rid === rid && r.tableId === tableId && !r.resolvedAt);
        if (found) return found;
        const row = { id: ID, rid, tableId, tableLabel: '7', createdAt: new Date().toISOString(), resolvedAt: null };
        rows.push(row); return row;
      },
      listPending: async (rid: string) => rows.filter(r => r.rid === rid && !r.resolvedAt),
      resolve: async (rid: string, id: string) => { const row = rows.find(r => r.rid === rid && r.id === id && !r.resolvedAt); if (!row) return false; row.resolvedAt = new Date().toISOString(); return true; },
    },
  } as unknown as Repos;
  setBackendForTests(repos, { verify: async (token: string) => ['owner', 'other', 'waiter'].includes(token) ? token : null } as AuthProvider);
}
const request = (path: string, method = 'GET', token?: string, data?: unknown, ip = 'staff-call-test') => app.request(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', 'x-forwarded-for': ip }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });

test('guest call reaches only the correct restaurant and waiter can mark it handled', async () => {
  setup();
  assert.equal((await request('/staff/calls')).status, 401);
  const created = await request('/public/r/test/staff-calls', 'POST', undefined, { tableId: TABLE });
  assert.equal(created.status, 200); assert.equal((await created.json()).call.tableLabel, '7');
  const repeat = await request('/public/r/test/staff-calls', 'POST', undefined, { tableId: TABLE });
  assert.equal((await repeat.json()).call.id, ID);
  assert.equal((await (await request('/staff/calls', 'GET', 'owner')).json()).calls.length, 1);
  assert.equal((await (await request('/staff/calls', 'GET', 'other')).json()).calls.length, 0);
  assert.equal((await request(`/staff/calls/${ID}/resolve`, 'POST', 'other')).status, 404);
  assert.equal((await request(`/staff/calls/${ID}/resolve`, 'POST', 'waiter')).status, 204);
  assert.equal((await (await request('/staff/calls', 'GET', 'owner')).json()).calls.length, 0);
  assert.equal((await request(`/staff/calls/${ID}/resolve`, 'POST', 'owner')).status, 404);
});
test('malformed, inactive or foreign tables and suspended restaurants cannot send calls', async () => {
  setup();
  for (const tableId of ['', 'not-a-uuid', '-'.repeat(36), OTHER]) assert.equal((await request('/public/r/test/staff-calls', 'POST', undefined, { tableId }, 'validation')).status, 400);
  assert.equal((await request('/public/r/missing/staff-calls', 'POST', undefined, { tableId: TABLE }, 'validation')).status, 404);
  assert.equal((await request('/public/r/suspended/staff-calls', 'POST', undefined, { tableId: TABLE }, 'validation')).status, 404);
  assert.equal((await request('/staff/calls/not-a-uuid/resolve', 'POST', 'owner')).status, 400);
});
test('staff call endpoint rate limits repeated requests', async () => {
  setup();
  for (let i = 0; i < 10; i++) assert.equal((await request('/public/r/test/staff-calls', 'POST', undefined, { tableId: TABLE }, 'flood')).status, 200);
  assert.equal((await request('/public/r/test/staff-calls', 'POST', undefined, { tableId: TABLE }, 'flood')).status, 429);
});
