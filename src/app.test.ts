// Run: npm test. Pure validation only; no database needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidUpiId } from "./contract";
import { readRestaurantPatch } from "./app";

const rejects = (b: object) => assert.throws(() => readRestaurantPatch(b), (e: { status?: number }) => e.status === 400);

test("UPI ID format", () => {
  for (const ok of ["spiceroute@okaxis", "9876543210@ybl", "a.b-c_d@paytm"]) assert.ok(isValidUpiId(ok), ok);
  for (const no of ["", "spiceroute", "@okaxis", "a@okaxis", "name@ok1", "name@b", "name @okaxis", "a@b@okaxis"]) {
    assert.ok(!isValidUpiId(no), no);
  }
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
