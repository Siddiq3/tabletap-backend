// Run: npm test. Login rules, PINs and staff permissions, against in-memory fakes (no database).
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectIdentifier, normalizeIndianPhone, type Membership, type StaffMember } from "./contract";
import { hashPin, verifyPin } from "./pin";
import { setBackendForTests } from "./adapters";
import type { AuthProvider, Repos } from "./ports";
import { app, readSignup } from "./app";

test("identifier detection: email, phone or username", () => {
  assert.deepEqual(detectIdentifier(" Ravi@Example.com "), { kind: "email", value: "ravi@example.com" });
  assert.deepEqual(detectIdentifier("98765 43210"), { kind: "phone", value: "+919876543210" });
  assert.deepEqual(detectIdentifier("+91-98765-43210"), { kind: "phone", value: "+919876543210" });
  assert.deepEqual(detectIdentifier("Spice.Route_1"), { kind: "username", value: "spice.route_1" });
  for (const no of ["", "ab", "not an email@", "a@b", "has space", "12345", "x".repeat(31)]) assert.equal(detectIdentifier(no), null, no);
});

test("Indian phone numbers normalise to +91XXXXXXXXXX", () => {
  for (const ok of ["9876543210", "09876543210", "919876543210", "+91 98765 43210", "(+91) 98765-43210"]) {
    assert.equal(normalizeIndianPhone(ok), "+919876543210", ok);
  }
  for (const no of ["5876543210", "987654321", "98765432100", "+1 9876543210", "abc"]) assert.equal(normalizeIndianPhone(no), null, no);
});

test("signup needs a username and email or phone", () => {
  const ok = readSignup({ fullName: " Asha ", username: "Asha.K", password: "longenough", phone: "98765 43210" });
  assert.deepEqual(ok.profile, { fullName: "Asha", username: "asha.k", email: null, phone: "+919876543210" });
  const rejects = (b: object) => assert.throws(() => readSignup(b), (e: { status?: number }) => e.status === 400);
  rejects({ fullName: "A", username: "asha", password: "longenough" }); // neither email nor phone
  rejects({ fullName: "A", username: "asha", password: "short", email: "a@b.co" });
  rejects({ fullName: "A", username: "9876543210", password: "longenough", email: "a@b.co" });
});

test("PIN hashing: salted, verifies only the right PIN", async () => {
  const a = await hashPin("1234");
  const b = await hashPin("1234");
  assert.notEqual(a, b);
  assert.ok(!a.includes("1234"));
  assert.ok(await verifyPin("1234", a));
  assert.ok(!(await verifyPin("1235", a)));
  assert.ok(!(await verifyPin("1234", "garbage")));
});

// ---------- HTTP against fakes ----------
const RID = "11111111-1111-1111-1111-111111111111";
const WAITER = "22222222-2222-2222-2222-222222222222";
const MANAGER = "33333333-3333-3333-3333-333333333333";
const owner: Membership = {
  role: "owner",
  restaurant: { id: RID, slug: "spice", name: "Spice", address: null, upiId: null, taxPercent: 5, plan: "trial" },
};

async function fakeBackend() {
  type Row = StaffMember & { restaurantId: string; pinHash: string; attempts: number; lockedUntil: number };
  const staff = new Map<string, Row>([
    [WAITER, { id: WAITER, name: "Ravi", role: "waiter", isActive: true, restaurantId: RID, pinHash: await hashPin("4321"), attempts: 0, lockedUntil: 0 }],
    [MANAGER, { id: MANAGER, name: "Meena", role: "manager", isActive: true, restaurantId: RID, pinHash: await hashPin("5555"), attempts: 0, lockedUntil: 0 }],
  ]);
  const sessions = new Map<string, string>();
  const pub = ({ id, name, role, isActive }: Row): StaffMember => ({ id, name, role, isActive });
  const repos = {
    restaurants: { getMembership: async () => owner },
    menu: { addCategory: async (_: string, name: string) => ({ id: "c1", name, sortOrder: 0 }) },
    staff: {
      list: async () => [...staff.values()].map(pub),
      get: async (_: string, id: string) => (staff.get(id) ? pub(staff.get(id)!) : null),
      // Same behaviour as claim_pin_attempt() in 0003_auth_staff.sql
      claimPinAttempt: async (id: string) => {
        const s = staff.get(id);
        if (!s || !s.isActive || s.lockedUntil > Date.now()) return null;
        s.attempts++;
        if (s.attempts >= 5) { s.attempts = 0; s.lockedUntil = Date.now() + 5 * 60_000; }
        return { pinHash: s.pinHash, restaurantId: s.restaurantId };
      },
      create: async (_: string, i: { name: string; role: StaffMember["role"] }) => ({ id: "new", name: i.name, role: i.role, isActive: true }),
      setPinHash: async () => {},
      revokeSessions: async () => {},
      pinSucceeded: async (id: string) => { const s = staff.get(id)!; s.attempts = 0; s.lockedUntil = 0; },
      createSession: async (id: string, hash: string) => { sessions.set(hash, id); },
      findSession: async (hash: string) => {
        const s = staff.get(sessions.get(hash) ?? "");
        return s?.isActive ? { staff: pub(s), restaurantId: s.restaurantId } : null;
      },
    },
  } as unknown as Repos;
  const auth = { verify: async (t: string) => (t === "owner-token" ? "owner-user" : null) } as AuthProvider;
  setBackendForTests(repos, auth);
  return staff;
}

const call = (path: string, body: unknown, staffSession?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      Authorization: "Bearer owner-token",
      "Content-Type": "application/json",
      "X-Forwarded-For": `10.0.0.${Math.floor(Math.random() * 250)}`, // keep the per-IP limiter out of the way
      ...(staffSession ? { "X-Staff-Session": staffSession } : {}),
    },
    body: JSON.stringify(body),
  });

test("5 wrong PINs lock the staff member, even with the right PIN after", async () => {
  const staff = await fakeBackend();
  for (let i = 1; i <= 5; i++) assert.equal((await call("/staff/pin-session", { staffId: WAITER, pin: "0000" })).status, 400, `try ${i}`);
  assert.equal((await call("/staff/pin-session", { staffId: WAITER, pin: "4321" })).status, 423);
  staff.get(WAITER)!.lockedUntil = Date.now() - 1; // 5 minutes later
  assert.equal((await call("/staff/pin-session", { staffId: WAITER, pin: "4321" })).status, 200);
});

test("a correct PIN resets the count", async () => {
  await fakeBackend();
  for (let i = 0; i < 4; i++) await call("/staff/pin-session", { staffId: WAITER, pin: "0000" });
  assert.equal((await call("/staff/pin-session", { staffId: WAITER, pin: "4321" })).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await call("/staff/pin-session", { staffId: WAITER, pin: "0000" })).status, 400);
});

test("a waiter session can't use owner-only routes; the owner's own login can", async () => {
  await fakeBackend();
  const res = await call("/staff/pin-session", { staffId: WAITER, pin: "4321" });
  const { token } = (await res.json()) as { token: string };

  assert.equal((await call("/staff/menu/categories", { name: "Starters" }, token)).status, 403);
  assert.equal((await call("/staff/members", { name: "X", role: "kitchen", pin: "1111" }, token)).status, 403);
  // starting a PIN session is decided by the device's owner login, not the waiter using it
  assert.equal((await call("/staff/pin-session", { staffId: WAITER, pin: "4321" }, token)).status, 200);
  assert.equal((await call("/staff/menu/categories", { name: "Starters" })).status, 201);

  const expired = await call("/staff/menu/categories", { name: "Starters" }, "not-a-real-token");
  assert.equal(expired.status, 401);
  assert.equal(((await expired.json()) as { code?: string }).code, "STAFF_SESSION");
});

test("a PIN manager manages cashier/kitchen/waiter but not managers", async () => {
  await fakeBackend();
  const { token } = (await (await call("/staff/pin-session", { staffId: MANAGER, pin: "5555" })).json()) as { token: string };
  assert.equal((await call("/staff/members", { name: "K", role: "kitchen", pin: "1111" }, token)).status, 201);
  assert.equal((await call(`/staff/members/${WAITER}/pin`, { pin: "9999" }, token)).status, 204);
  assert.equal((await call("/staff/members", { name: "M", role: "manager", pin: "1111" }, token)).status, 403);
  assert.equal((await call(`/staff/members/${MANAGER}/pin`, { pin: "9999" }, token)).status, 403);
  assert.equal((await call("/staff/members", { name: "M", role: "manager", pin: "1111" })).status, 201); // owner's own login
});
