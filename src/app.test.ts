// Run: npm test. Pure validation only; no database needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION, isValidUpiId, upiLink } from "./contract";
import { app, readRestaurantPatch } from "./app";

const rejects = (b: object) => assert.throws(() => readRestaurantPatch(b), (e: { status?: number }) => e.status === 400);

test("UPI ID format", () => {
  for (const ok of ["spiceroute@okaxis", "9876543210@ybl", "a.b-c_d@paytm"]) assert.ok(isValidUpiId(ok), ok);
  for (const no of ["", "spiceroute", "@okaxis", "a@okaxis", "name@ok1", "name@b", "name @okaxis", "a@b@okaxis"]) {
    assert.ok(!isValidUpiId(no), no);
  }
});

test("upiLink: literal @, %20 not +, 2-decimal amount from paise", () => {
  assert.equal(
    upiLink("spice.route@okaxis", "Spice Route Kitchen", 48000, "Order 1042"),
    "upi://pay?pa=spice.route@okaxis&pn=Spice%20Route%20Kitchen&am=480.00&cu=INR&tn=Order%201042",
  );
});

test("only sent fields change; empty removes address and UPI ID", () => {
  assert.deepEqual(readRestaurantPatch({ upiId: " cafe@okhdfc " }), { upiId: "cafe@okhdfc" });
  assert.deepEqual(readRestaurantPatch({ upiId: "", address: "  " }), { upiId: null, address: null });
});

test("rejects bad values", () => {
  rejects({});
  rejects({ upiId: "not-a-upi" });
  rejects({ name: "A" });
  rejects({ name: "x".repeat(81) });
  rejects({ taxPercent: -1 });
  rejects({ taxPercent: 28.01 });
  rejects({ taxPercent: 5.125 });
  rejects({ taxPercent: "5" });
});

test("GST 0 to 28 with up to 2 decimals", () => {
  for (const t of [0, 5, 12, 18.15, 0.29, 28]) assert.deepEqual(readRestaurantPatch({ taxPercent: t }), { taxPercent: t });
});

// HTTP behaviour that must survive Hono upgrades. None of these reach the database.
test("health, CORS, auth and 404 over HTTP", async () => {
  const health = await app.request("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, contractVersion: CONTRACT_VERSION });

  const preflight = (origin: string) =>
    app.request("/staff/orders", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "PATCH", "Access-Control-Request-Headers": "authorization,content-type" },
    });
  const allowed = await preflight("http://localhost:3000");
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.match(allowed.headers.get("access-control-allow-methods") ?? "", /PATCH/);
  assert.equal((await preflight("https://evil.example")).headers.get("access-control-allow-origin"), null);

  const me = await app.request("/me");
  assert.equal(me.status, 401);
  assert.deepEqual(await me.json(), { error: "Please log in again." });

  const missing = await app.request("/nope");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Not found." });
});
