// Run: npm test. Email codes, resend limits, the EMAIL_UNVERIFIED gate and password resets, against fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { UserProfile } from "./contract";
import { setBackendForTests } from "./adapters";
import type { AuthProvider, Mailer, Repos } from "./ports";
import { app, resendWait } from "./app";

const USER = "44444444-4444-4444-4444-444444444444";

/** In-memory profiles + codes. Codes behave like claim_verification_attempt() in 0005. */
function fakeBackend(profile: UserProfile | null) {
  const sent: { to: string; text: string }[] = [];
  let codes: { codeHash: string; expiresAt: number; attempts: number; createdAt: string }[] = [];
  const profiles = {
    get: async () => profile,
    find: async () => (profile ? { userId: USER, ...profile } : null),
    markEmailVerified: async () => { profile = { ...profile!, emailVerified: true }; },
  };
  const emailCodes = {
    create: async (_: string, codeHash: string, expiresAt: string) => {
      codes.unshift({ codeHash, expiresAt: Date.parse(expiresAt), attempts: 0, createdAt: new Date().toISOString() });
    },
    sentSince: async (_: string, since: string) => codes.filter((c) => c.createdAt >= since).map((c) => c.createdAt),
    claimAttempt: async () => {
      const c = codes[0];
      if (!c || c.expiresAt <= Date.now() || c.attempts >= 5) return null;
      c.attempts++;
      return { codeHash: c.codeHash, attemptsLeft: 5 - c.attempts };
    },
    deleteAll: async () => { codes = []; },
  };
  const repos = {
    profiles,
    emailCodes,
    restaurants: { getMembership: async () => null },
  } as unknown as Repos;
  const auth = {
    verify: async (t: string) => (t === "user-token" ? USER : null),
    createPasswordResetLink: async (email: string) => `https://reset.example/?for=${email}`,
  } as unknown as AuthProvider;
  const mailer: Mailer = {
    sendVerificationCode: async (to, code) => { sent.push({ to, text: code }); },
    sendPasswordReset: async (to, link) => { sent.push({ to, text: link }); },
  };
  setBackendForTests(repos, auth, mailer);
  return {
    sent,
    codes: () => codes,
    lastCode: () => sent.filter((m) => /^\d{6}$/.test(m.text)).at(-1)?.text ?? "",
    profile: () => profile,
  };
}

const unverified: UserProfile = { fullName: "Asha", username: "asha", email: "asha@example.com", phone: null, emailVerified: false };

const post = (path: string, body: unknown = {}, ip = `10.1.0.${Math.floor(Math.random() * 250)}`) =>
  app.request(path, {
    method: "POST",
    headers: { Authorization: "Bearer user-token", "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify(body),
  });

test("resend limits: 60 seconds apart, at most 5 per hour", () => {
  const now = Date.parse("2026-11-10T10:00:00Z");
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  assert.equal(resendWait([], now), 0);
  assert.equal(resendWait([ago(20)], now), 40);
  assert.equal(resendWait([ago(60)], now), 0);
  assert.equal(resendWait([ago(61 * 60)], now), 0); // older than an hour doesn't count
  // 5 in the last hour; the oldest of them was 50 minutes ago → 10 minutes to wait
  assert.equal(resendWait([ago(100), ago(200), ago(300), ago(400), ago(50 * 60)], now), 600);
});

test("unverified email: EMAIL_UNVERIFIED on staff and restaurant routes, but /me and verify routes work", async () => {
  fakeBackend(unverified);
  for (const [method, path] of [["GET", "/staff/orders"], ["POST", "/restaurants"]]) {
    const res = await app.request(path, { method, headers: { Authorization: "Bearer user-token" } });
    assert.equal(res.status, 403, path);
    assert.equal(((await res.json()) as { code?: string }).code, "EMAIL_UNVERIFIED", path);
  }
  const me = await app.request("/me", { headers: { Authorization: "Bearer user-token" } });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as { profile: UserProfile }).profile.emailVerified, false);
  assert.equal((await post("/auth/resend-code")).status, 200);
});

test("right code verifies and opens the dashboard routes", async () => {
  const f = fakeBackend(unverified);
  await post("/auth/resend-code");
  assert.equal((await post("/auth/verify-email", { code: f.lastCode() })).status, 204);
  assert.equal(f.profile()!.emailVerified, true);
  assert.equal(f.codes().length, 0);
  const res = await app.request("/staff/orders", { headers: { Authorization: "Bearer user-token" } });
  assert.notEqual(((await res.json()) as { code?: string }).code, "EMAIL_UNVERIFIED");
});

test("codes expire after 10 minutes", async () => {
  const f = fakeBackend(unverified);
  await post("/auth/resend-code");
  const c = f.codes()[0];
  assert.ok(c.expiresAt - Date.now() > 9.9 * 60_000 && c.expiresAt - Date.now() <= 10 * 60_000);
  c.expiresAt = Date.now() - 1;
  const res = await post("/auth/verify-email", { code: f.lastCode() });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /expired/);
});

test("5 wrong codes use the code up; even the right one fails after", async () => {
  const f = fakeBackend(unverified);
  await post("/auth/resend-code");
  const right = f.lastCode();
  const wrong = right === "000000" ? "111111" : "000000";
  for (let left = 4; left >= 0; left--) {
    const res = await post("/auth/verify-email", { code: wrong });
    assert.equal(res.status, 400);
    if (left > 0) assert.match(((await res.json()) as { error: string }).error, new RegExp(`${left} tr`));
  }
  assert.equal((await post("/auth/verify-email", { code: right })).status, 400);
  assert.equal(f.profile()!.emailVerified, false);
});

test("resend within 60 seconds is refused with retryAfterSeconds", async () => {
  fakeBackend(unverified);
  const first = await post("/auth/resend-code");
  assert.deepEqual(await first.json(), { retryAfterSeconds: 60 });
  const again = await post("/auth/resend-code");
  assert.equal(again.status, 429);
  const body = (await again.json()) as { retryAfterSeconds: number };
  assert.ok(body.retryAfterSeconds > 55 && body.retryAfterSeconds <= 60);
});

test("password reset goes only to verified emails; same answer otherwise", async () => {
  const forgot = (identifier: string) => post("/auth/forgot-password", { identifier });

  let f = fakeBackend(unverified);
  const res = await forgot("asha");
  const unverifiedAnswer = await res.json();
  assert.equal(f.sent.length, 0);

  f = fakeBackend({ ...unverified, emailVerified: true });
  assert.deepEqual(await (await forgot("asha")).json(), unverifiedAnswer);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, "asha@example.com");
  assert.match(f.sent[0].text, /^https:\/\/reset\.example/);

  f = fakeBackend(null); // unknown username
  assert.deepEqual(await (await forgot("nobody")).json(), unverifiedAnswer);
  assert.equal(f.sent.length, 0);
});
