import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import {
  CONTRACT_VERSION, DomainError, isValidFssai, isValidGstin, EMAIL_UNVERIFIED_ERROR, PASSWORD_MIN, RESEND_CODE_SECONDS, isValidEmailCode, STAFF_SESSION_ERROR, canMoveTo, detectIdentifier, isValidEmail,
  isValidPin, isValidUpiId, isValidUsername, normalizeIndianPhone, slugify,
  type CreateRestaurantRequest, type LoginRequest, type Membership, type MenuItemPatch, type NewMenuItem,
  type NewStaffRequest, type OrderStatus, type PaymentMethod, type PinSessionRequest, type PlaceOrderRequest,
  type PublicRestaurant, type Restaurant, type Role, type SignupRequest, type StaffMember, type StaffPatch,
  type BillPatch, type BillPaymentRequest, type StaffOrderRequest, type StaffRole, type UpdateRestaurantRequest,
} from "./contract";
import { randomInt } from "node:crypto";
import { getAuth, getMailer, getRepos } from "./adapters";
import { clientIp, limiter, rateLimit } from "./rate-limit";
import { hashPin, hashToken, newToken, verifyPin } from "./pin";

type Env = {
  Variables: {
    userId: string;
    /** Effective: the PIN staff member's role while a staff session is active, else the login's own role. */
    membership: Membership;
    /** Role of the account logged in on the device, whatever staff member is using it. */
    deviceRole: Role;
    /** The PIN staff member acting, if any. */
    staff: StaffMember | null;
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGERS: Role[] = ["owner", "manager"];
const CASHIERS: Role[] = ["owner", "manager", "cashier"];
/** Everyone who serves guests can add items to a table; the kitchen only cooks. */
const ORDER_TAKERS: Role[] = ["owner", "manager", "cashier", "waiter"];
const STATUSES: OrderStatus[] = ["new", "preparing", "ready", "served", "cancelled"];
const METHODS: PaymentMethod[] = ["upi", "cash", "card", "online"];
const STAFF_ROLES: StaffRole[] = ["manager", "cashier", "kitchen", "waiter"];
const STAFF_SESSION_MS = 8 * 60 * 60_000;
const WRONG_LOGIN = "Wrong login or password.";

function bad(message: string): never {
  throw new HTTPException(400, { message });
}
function notFound(message = "Not found."): never {
  throw new HTTPException(404, { message });
}
type ItemBody = Partial<NewMenuItem & { isAvailable: boolean }>;
const body = async <T>(c: { req: { json: () => Promise<unknown> } }): Promise<Partial<T>> =>
  ((await c.req.json().catch(() => null)) ?? {}) as Partial<T>;

const UPI_HINT = "UPI ID looks wrong. It should look like name@okaxis.";

type RestaurantPatch = Partial<Pick<Restaurant, "name" | "address" | "upiId" | "taxPercent" | "gstin" | "fssai" | "serviceChargePercent" | "packagingPaise">>;

/** Validates PATCH /staff/restaurant. Only fields that were sent are changed; "" removes address or UPI ID. */
export function readRestaurantPatch(b: Partial<UpdateRestaurantRequest>): RestaurantPatch {
  const out: RestaurantPatch = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (name.length < 2 || name.length > 80) bad("Restaurant name must be 2 to 80 characters.");
    out.name = name;
  }
  if (b.address !== undefined) {
    const address = String(b.address ?? "").trim();
    if (address.length > 200) bad("Address is too long. Keep it under 200 characters.");
    out.address = address || null;
  }
  if (b.upiId !== undefined) {
    const upiId = String(b.upiId ?? "").trim();
    if (upiId && !isValidUpiId(upiId)) bad(UPI_HINT);
    out.upiId = upiId || null;
  }
  if (b.taxPercent !== undefined) {
    const tax = b.taxPercent;
    // numeric(5,2) in the database: at most 2 decimals
    if (typeof tax !== "number" || !Number.isFinite(tax) || tax < 0 || tax > 28 || Math.abs(Math.round(tax * 100) - tax * 100) > 1e-6) {
      bad("GST must be between 0 and 28%.");
    }
    out.taxPercent = tax;
  }
  if (b.gstin !== undefined) {
    const gstin = String(b.gstin ?? "").trim().toUpperCase();
    if (gstin && !isValidGstin(gstin)) bad("GSTIN should be 15 characters, like 29ABCDE1234F1Z5.");
    out.gstin = gstin || null;
  }
  if (b.fssai !== undefined) {
    const fssai = String(b.fssai ?? "").replace(/\s/g, "");
    if (fssai && !isValidFssai(fssai)) bad("FSSAI licence number is 14 digits.");
    out.fssai = fssai || null;
  }
  if (b.serviceChargePercent !== undefined) {
    const v = b.serviceChargePercent;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 20 || Math.abs(Math.round(v * 100) - v * 100) > 1e-6) bad("Service charge must be between 0 and 20%.");
    out.serviceChargePercent = v;
  }
  if (b.packagingPaise !== undefined) {
    const v = b.packagingPaise;
    if (!Number.isInteger(v) || v < 0 || v > 100000) bad("Packaging charge must be between ₹0 and ₹1,000.");
    out.packagingPaise = v;
  }
  if (Object.keys(out).length === 0) bad("Nothing to update.");
  return out;
}

const toPublic = (r: Restaurant): PublicRestaurant => ({
  name: r.name, slug: r.slug, address: r.address, taxPercent: r.taxPercent, upiId: r.upiId,
});

export const app = new Hono<Env>();

// ---------- cross-cutting ----------
const allowed = (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim());
app.use(
  "*",
  cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    allowHeaders: ["Content-Type", "Authorization", "X-Staff-Session"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
);

app.onError((err, c) => {
  if (err instanceof DomainError) return c.json({ error: err.message, code: err.code }, 409);
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Something went wrong. Try again." }, 500);
});

app.notFound((c) => c.json({ error: "Not found." }, 404));

app.get("/health", (c) => c.json({ ok: true, contractVersion: CONTRACT_VERSION }));

// ---------- guests (no login) ----------
app.get("/public/r/:slug", async (c) => {
  const repos = getRepos();
  const r = await repos.restaurants.getBySlug(c.req.param("slug"));
  if (!r || r.plan === "suspended") notFound("Restaurant not found.");
  const restaurant = r as Restaurant;
  const t = c.req.query("t");
  const [menu, table] = await Promise.all([
    repos.menu.list(restaurant.id),
    t ? repos.restaurants.getTable(restaurant.id, t) : Promise.resolve(null),
  ]);
  return c.json({
    restaurant: toPublic(restaurant),
    table: table?.isActive ? { id: table.id, label: table.label } : null,
    menu,
  });
});

const CART_ERROR = "The order could not be read. Refresh the page and try again.";

/** Same item checks for a guest's cart and for items staff add; prices always come from the database. */
function readItems(b: { items?: unknown; note?: unknown }) {
  const items = (Array.isArray(b.items) ? b.items : []) as { menuItemId: string; qty: number }[];
  const valid = items.length > 0 && items.length <= 60 &&
    items.every((i) => i && typeof i.menuItemId === "string" && UUID.test(i.menuItemId) && Number.isInteger(i.qty) && i.qty >= 1 && i.qty <= 50);
  if (!valid) bad(CART_ERROR);
  return { items: items.map((i) => ({ menuItemId: i.menuItemId, qty: i.qty })), note: typeof b.note === "string" ? b.note.slice(0, 300) : "" };
}

/** Staff orders go to exactly one place: a table, an open bill, or a new takeaway. */
function readStaffOrder(b: Partial<StaffOrderRequest>) {
  const targets = [b.tableId !== undefined, b.billId !== undefined, b.takeaway !== undefined].filter(Boolean).length;
  if (targets !== 1) bad("Choose a table, a bill or takeaway for this order.");
  if (b.tableId !== undefined && !(typeof b.tableId === "string" && UUID.test(b.tableId))) bad("Unknown table.");
  if (b.billId !== undefined && !(typeof b.billId === "string" && UUID.test(b.billId))) bad("Unknown bill.");
  let takeaway: { customerName?: string; customerPhone?: string } | undefined;
  if (b.takeaway !== undefined) {
    const name = String(b.takeaway?.customerName ?? "").trim();
    const phone = String(b.takeaway?.customerPhone ?? "").replace(/[\s-]/g, "");
    if (name.length > 60) bad("Customer name is too long.");
    if (phone && !/^\+?[0-9]{6,14}$/.test(phone)) bad("Enter a valid phone number, or leave it empty.");
    takeaway = { customerName: name || undefined, customerPhone: phone || undefined };
  }
  return { tableId: b.tableId, billId: b.billId, takeaway, ...readItems(b) };
}

app.post("/public/orders", rateLimit(15, 60_000), async (c) => {
  const b = await body<PlaceOrderRequest>(c);
  if (typeof b.slug !== "string" || typeof b.tableId !== "string" || !UUID.test(b.tableId)) bad(CART_ERROR);
  const cart = { tableId: b.tableId as string, ...readItems(b) };

  const repos = getRepos();
  const restaurant = await repos.restaurants.getBySlug(b.slug as string);
  if (!restaurant) notFound("Restaurant not found.");

  const placed = await repos.orders.place({ restaurantId: restaurant!.id, ...cart, source: "qr", staffId: null });
  return c.json(placed, 201);
});

app.get("/public/r/:slug/orders/:id", async (c) => {
  const repos = getRepos();
  const restaurant = await repos.restaurants.getBySlug(c.req.param("slug"));
  if (!restaurant) notFound();
  const order = await repos.orders.get(restaurant!.id, c.req.param("id"));
  if (!order) notFound();
  c.header("Cache-Control", "no-store");
  return c.json({ restaurant: toPublic(restaurant!), order });
});

// The guest's table bill (all rounds, QR and waiter) so they can pay once. Only while their own
// order is still on the open bill: after settling, later diners' orders at the table stay private.
app.get("/public/r/:slug/orders/:id/bill", async (c) => {
  const repos = getRepos();
  const restaurant = await repos.restaurants.getBySlug(c.req.param("slug"));
  if (!restaurant) notFound();
  const id = c.req.param("id");
  c.header("Cache-Control", "no-store");
  if (!(await repos.orders.get(restaurant!.id, id))) notFound();
  return c.json({ bill: await repos.bills.openBillForOrder(restaurant!.id, id) });
});

// Guest requests are validated against an active table; the database coalesces repeat taps.
app.post("/public/r/:slug/staff-calls", rateLimit(10, 60_000, "Too many staff calls. Please wait a minute."), async (c) => {
  const { tableId } = await body<{ tableId: string }>(c);
  if (typeof tableId !== "string" || !UUID.test(tableId)) bad("Scan the QR code on your table to call staff.");
  const repos = getRepos();
  const restaurant = await repos.restaurants.getBySlug(c.req.param("slug"));
  if (!restaurant || restaurant.plan === "suspended") notFound("Restaurant not found.");
  const table = await repos.restaurants.getTable(restaurant!.id, tableId!);
  if (!table?.isActive) bad("This table is not active. Please ask the staff for help.");
  const call = await repos.staffCalls.request(restaurant!.id, tableId!);
  c.header("Cache-Control", "no-store");
  return c.json({ call });
});

// ---------- owner/manager login ----------
/** Validates POST /auth/signup. Returns the normalised profile + password. */
export function readSignup(b: Partial<SignupRequest>) {
  const fullName = String(b.fullName ?? "").trim();
  const username = String(b.username ?? "").trim().toLowerCase();
  const password = String(b.password ?? "");
  const emailRaw = String(b.email ?? "").trim().toLowerCase();
  const phoneRaw = String(b.phone ?? "").trim();
  if (!fullName || fullName.length > 80) bad("Enter your full name.");
  if (!isValidUsername(username)) bad("Username must be 3 to 30 characters: a–z, 0–9, _ or . and at least one letter.");
  // 72: bcrypt (Supabase, Cognito-compatible) ignores anything longer
  if (password.length < PASSWORD_MIN || password.length > 72) bad(`Password must be ${PASSWORD_MIN} to 72 characters.`);
  if (emailRaw && !isValidEmail(emailRaw)) bad("That email looks wrong.");
  const phone = phoneRaw ? normalizeIndianPhone(phoneRaw) : null;
  if (phoneRaw && !phone) bad("Enter a 10-digit Indian mobile number.");
  if (!emailRaw && !phone) bad("Enter your email or phone number, so you can log in with it.");
  return { profile: { fullName, username, email: emailRaw || null, phone }, password };
}

app.post("/auth/signup", rateLimit(10, 60 * 60_000, "Too many sign-ups from this network. Try again in an hour."), async (c) => {
  const { profile, password } = readSignup(await body<SignupRequest>(c));
  const repos = getRepos();
  const auth = getAuth();
  // Friendly errors before creating anything; the unique constraints still catch races.
  if (await repos.profiles.find({ kind: "username", value: profile.username })) throw new DomainError("USERNAME_TAKEN", "That username is taken. Try another.");
  if (profile.phone && (await repos.profiles.find({ kind: "phone", value: profile.phone }))) {
    throw new DomainError("PHONE_TAKEN", "An account with this phone number already exists. Log in instead.");
  }
  const userId = await auth.createUser({ email: profile.email, password });
  try {
    await repos.profiles.create(userId, profile);
  } catch (e) {
    await auth.deleteUser(userId);
    throw e;
  }
  const session = await auth.signInWithPassword({ userId }, password);
  if (!session) throw new Error("signup: sign-in right after createUser failed");
  if (profile.email) {
    // The account exists either way; if this email fails, "Resend code" on the next screen sends another.
    await sendEmailCode(userId, profile.email).catch((e) => console.error("signup verification email", e));
  }
  return c.json({ session }, 201);
});

const loginHit = limiter(5, 10 * 60_000);
app.post("/auth/login", async (c) => {
  const b = await body<LoginRequest>(c);
  const raw = String(b.identifier ?? "");
  const password = String(b.password ?? "");
  if (!loginHit(`${clientIp(c)}|${raw.trim().toLowerCase()}`)) {
    throw new HTTPException(429, { message: "Too many login attempts. Wait 10 minutes and try again." });
  }
  const id = detectIdentifier(raw);
  if (!id || !password) throw new HTTPException(401, { message: WRONG_LOGIN });
  const profile = await getRepos().profiles.find(id);
  // Accounts from before v3 have no profile; their email still logs in.
  const who = profile ? { userId: profile.userId } : id.kind === "email" ? { email: id.value } : null;
  const session = who ? await getAuth().signInWithPassword(who, password) : null;
  if (!session) throw new HTTPException(401, { message: WRONG_LOGIN });
  return c.json({ session });
});

app.post("/auth/forgot-password", rateLimit(5, 10 * 60_000, "Too many reset requests. Wait 10 minutes and try again."), async (c) => {
  const id = detectIdentifier(String((await body<{ identifier: string }>(c)).identifier ?? ""));
  if (!id) bad("Enter your email, phone or username.");
  const profile = await getRepos().profiles.find(id!);
  if (profile && !profile.email) {
    return c.json({ emailSent: false, message: "Contact Tabletap support to reset your password." });
  }
  // Only to an email the owner has proven. Accounts from before v3 (no profile) proved theirs with the
  // old email-code login. Internal *.invalid login addresses never get mail.
  const email = profile ? (profile.emailVerified ? profile.email : null) : id!.kind === "email" ? id!.value : null;
  if (email && !email.endsWith(".invalid")) {
    try {
      const link = await getAuth().createPasswordResetLink(email);
      if (link) await getMailer().sendPasswordReset(email, link);
    } catch (e) {
      console.error("password reset email", e); // same answer either way: never reveal whether it exists
    }
  }
  return c.json({ emailSent: true, message: "If that account exists, we've emailed a link to reset your password." });
});

// ---------- email verification (logged in, email not verified yet) ----------
const CODE_TTL_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;
const RESENDS_PER_HOUR = 5;

/** Seconds until another code may be sent: 60 s between codes, at most 5 per hour. 0 = now. */
export function resendWait(sentNewestFirst: string[], now = Date.now()): number {
  const times = sentNewestFirst.map((t) => new Date(t).getTime()).filter((t) => t > now - HOUR_MS);
  if (times.length === 0) return 0;
  const gap = times[0] + RESEND_CODE_SECONDS * 1000 - now;
  const hourly = times.length >= RESENDS_PER_HOUR ? times[RESENDS_PER_HOUR - 1] + HOUR_MS - now : 0;
  return Math.max(0, Math.ceil(Math.max(gap, hourly) / 1000));
}

/** Sends a fresh code unless the resend limits say wait; returns seconds until the next one is allowed. */
async function sendEmailCode(userId: string, email: string): Promise<{ wait: number; sent: boolean }> {
  const repos = getRepos();
  const wait = resendWait(await repos.emailCodes.sentSince(userId, new Date(Date.now() - HOUR_MS).toISOString()));
  if (wait > 0) return { wait, sent: false };
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await repos.emailCodes.create(userId, await hashPin(code), new Date(Date.now() + CODE_TTL_MS).toISOString());
  await getMailer().sendVerificationCode(email, code);
  return { wait: RESEND_CODE_SECONDS, sent: true };
}

// ---------- signed-in ----------
const requireUser = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const userId = token ? await getAuth().verify(token) : null;
  if (!userId) throw new HTTPException(401, { message: "Please log in again." });
  c.set("userId", userId);
  await next();
});

/** Owners who signed up with an email must verify it before using the restaurant. */
const requireVerifiedEmail = createMiddleware<Env>(async (c, next) => {
  const profile = await getRepos().profiles.get(c.get("userId"));
  // No profile = account from before v3, which proved its email with the old email-code login.
  if (profile && !profile.emailVerified) {
    return c.json({ error: "Verify your email first. Enter the 6-digit code we sent you.", code: EMAIL_UNVERIFIED_ERROR }, 403);
  }
  await next();
});

app.post("/auth/verify-email", requireUser, async (c) => {
  const code = String((await body<{ code: string }>(c)).code ?? "").trim();
  const userId = c.get("userId");
  const repos = getRepos();
  const profile = await repos.profiles.get(userId);
  if (!profile?.email) throw new HTTPException(409, { message: "This account has no email to verify." });
  if (profile.emailVerified) return c.body(null, 204);
  if (!isValidEmailCode(code)) bad("Enter the 6-digit code from the email.");
  const claim = await repos.emailCodes.claimAttempt(userId);
  if (!claim) bad("This code has expired or was tried too many times. Tap Resend code for a new one.");
  if (!(await verifyPin(code, claim!.codeHash))) {
    bad(claim!.attemptsLeft > 0
      ? `Wrong code. ${claim!.attemptsLeft} ${claim!.attemptsLeft === 1 ? "try" : "tries"} left.`
      : "Wrong code. Tap Resend code for a new one.");
  }
  await repos.profiles.markEmailVerified(userId);
  await repos.emailCodes.deleteAll(userId);
  return c.body(null, 204);
});

app.post("/auth/resend-code", requireUser, async (c) => {
  const profile = await getRepos().profiles.get(c.get("userId"));
  if (!profile?.email) throw new HTTPException(409, { message: "This account has no email to verify." });
  if (profile.emailVerified) throw new HTTPException(409, { message: "Your email is already verified." });
  const { wait, sent } = await sendEmailCode(c.get("userId"), profile.email);
  if (!sent) {
    return c.json({ error: `Wait ${wait} seconds before asking for another code.`, code: "RATE_LIMITED", retryAfterSeconds: wait }, 429);
  }
  return c.json({ retryAfterSeconds: wait });
});

const requireMember = createMiddleware<Env>(async (c, next) => {
  const membership = await getRepos().restaurants.getMembership(c.get("userId"));
  if (!membership) throw new HTTPException(403, { message: "Set up your restaurant first." });
  if (membership.restaurant.plan === "suspended") {
    throw new HTTPException(402, { message: "Your plan is paused. Renew your subscription to continue." });
  }
  c.set("membership", membership);
  c.set("deviceRole", membership.role);
  c.set("staff", null);
  await next();
});

/** X-Staff-Session: a PIN staff member is using this device; their role replaces the device login's. */
const applyStaffSession = createMiddleware<Env>(async (c, next) => {
  const token = c.req.header("X-Staff-Session");
  if (token) {
    const found = await getRepos().staff.findSession(hashToken(token));
    const membership = c.get("membership");
    // Only on an owner/manager device of the same restaurant.
    if (!found || found.restaurantId !== membership.restaurant.id || !MANAGERS.includes(c.get("deviceRole"))) {
      return c.json({ error: "Staff session ended. Tap your name and enter your PIN again.", code: STAFF_SESSION_ERROR }, 401);
    }
    c.set("staff", found.staff);
    c.set("membership", { ...membership, role: found.staff.role });
  }
  await next();
});

const allow = (roles: Role[]) =>
  createMiddleware<Env>(async (c, next) => {
    if (!roles.includes(c.get("membership").role)) {
      throw new HTTPException(403, { message: "Your staff role can't do this. Ask the owner." });
    }
    await next();
  });

app.get("/me", requireUser, async (c) => {
  const repos = getRepos();
  const [membership, profile] = await Promise.all([
    repos.restaurants.getMembership(c.get("userId")),
    repos.profiles.get(c.get("userId")),
  ]);
  return c.json({ userId: c.get("userId"), membership, profile });
});

app.post("/restaurants", requireUser, requireVerifiedEmail, async (c) => {
  const b = await body<CreateRestaurantRequest>(c);
  const name = String(b.name ?? "").trim();
  const slug = slugify(String(b.slug ?? "") || name);
  const upiId = String(b.upiId ?? "").trim();
  const tableCount = Number(b.tableCount);

  if (name.length < 2) bad("Enter your restaurant's name.");
  if (slug.length < 3) bad("The menu link needs at least 3 letters or numbers.");
  if (!Number.isInteger(tableCount) || tableCount < 1 || tableCount > 200) bad("Tables must be between 1 and 200.");
  if (upiId && !isValidUpiId(upiId)) bad(UPI_HINT);

  const repos = getRepos();
  if (await repos.restaurants.getMembership(c.get("userId"))) {
    throw new HTTPException(409, { message: "You already have a restaurant." });
  }
  const restaurantId = await repos.restaurants.create({ name, slug, upiId: upiId || null, tableCount }, c.get("userId"));
  return c.json({ restaurantId }, 201);
});

// ---------- restaurant staff ----------
const staff = new Hono<Env>();
staff.use("*", requireUser, requireVerifiedEmail, requireMember, applyStaffSession);
const staffId = (c: { get: (k: "staff") => StaffMember | null }) => c.get("staff")?.id ?? null;

staff.get("/calls", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ calls: await getRepos().staffCalls.listPending(c.get("membership").restaurant.id) });
});

staff.post("/calls/:id/resolve", async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) bad("Unknown staff call.");
  const resolved = await getRepos().staffCalls.resolve(c.get("membership").restaurant.id, id, staffId(c));
  if (!resolved) notFound("This call was already handled or is not available.");
  return c.body(null, 204);
});

staff.get("/orders", async (c) => {
  const orders = await getRepos().orders.listBoard(c.get("membership").restaurant.id);
  return c.json({ orders });
});

// ---------- bills ----------
// A guest asks the waiter for more, a walk-in orders at the counter, or a takeaway: all join a bill.
staff.post("/orders", allow(ORDER_TAKERS), async (c) => {
  const order = readStaffOrder(await body<StaffOrderRequest>(c));
  const placed = await getRepos().orders.place({ restaurantId: c.get("membership").restaurant.id, ...order, source: "staff", staffId: staffId(c) });
  return c.json(placed, 201);
});

const rid = (c: { get: (k: "membership") => Membership }) => c.get("membership").restaurant.id;
const billParam = (c: { req: { param: (k: string) => string } }) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) bad("Unknown bill.");
  return id;
};
async function billOr404(restaurantId: string, billId: string) {
  const bill = await getRepos().bills.get(restaurantId, billId);
  if (!bill) notFound("Bill not found.");
  return bill!;
}

staff.get("/bills", allow(ORDER_TAKERS), async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ bills: await getRepos().bills.listOpen(rid(c)) });
});

staff.get("/bills/:id", allow(ORDER_TAKERS), async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ bill: await billOr404(rid(c), billParam(c)) });
});

// One payment; several make a split. The bill closes when the total is covered.
staff.post("/bills/:id/payments", allow(CASHIERS), async (c) => {
  const id = billParam(c);
  const b = await body<BillPaymentRequest>(c);
  if (!b.method || !METHODS.includes(b.method)) bad("Choose how this was paid.");
  if (!Number.isInteger(b.amountPaise) || (b.amountPaise as number) <= 0) bad("Enter an amount up to the balance due.");
  if (!Number.isInteger(b.expectedTotalPaise)) bad("Refresh the bill and try again.");
  await getRepos().bills.pay(rid(c), id, { method: b.method, amountPaise: b.amountPaise as number, expectedTotalPaise: b.expectedTotalPaise as number }, staffId(c));
  return c.json({ bill: await billOr404(rid(c), id) });
});

// Discounts and waiving the service charge: owner/manager only, discount needs a reason.
staff.patch("/bills/:id", allow(MANAGERS), async (c) => {
  const id = billParam(c);
  const b = await body<BillPatch>(c);
  const patch: { discountPaise?: number; discountReason?: string | null; serviceChargeOn?: boolean } = {};
  if (b.discountPaise !== undefined) {
    if (!Number.isInteger(b.discountPaise) || b.discountPaise < 0 || b.discountPaise > 10_000_000) bad("Enter a discount in rupees.");
    const reason = String(b.discountReason ?? "").trim();
    if (b.discountPaise > 0 && (reason.length < 2 || reason.length > 120)) bad("Give a short reason for the discount.");
    patch.discountPaise = b.discountPaise;
    patch.discountReason = b.discountPaise > 0 ? reason : null;
  }
  if (b.serviceChargeOn !== undefined) patch.serviceChargeOn = !!b.serviceChargeOn;
  if (Object.keys(patch).length === 0) bad("Nothing to update.");
  if (!(await getRepos().bills.update(rid(c), id, patch))) notFound("This bill is already closed.");
  return c.json({ bill: await billOr404(rid(c), id) });
});

staff.post("/bills/:id/move", allow(ORDER_TAKERS), async (c) => {
  const id = billParam(c);
  const { tableId } = await body<{ tableId: string }>(c);
  if (typeof tableId !== "string" || !UUID.test(tableId)) bad("Choose a table.");
  await getRepos().bills.move(rid(c), id, tableId);
  return c.body(null, 204);
});

staff.post("/bills/:id/merge", allow(CASHIERS), async (c) => {
  const id = billParam(c);
  const { intoBillId } = await body<{ intoBillId: string }>(c);
  if (typeof intoBillId !== "string" || !UUID.test(intoBillId) || intoBillId === id) bad("Choose another open bill.");
  await getRepos().bills.merge(rid(c), id, intoBillId, staffId(c));
  return c.body(null, 204);
});

staff.post("/bills/:id/void", allow(MANAGERS), async (c) => {
  const id = billParam(c);
  const reason = String((await body<{ reason: string }>(c)).reason ?? "").trim();
  if (reason.length < 2 || reason.length > 120) bad("Give a short reason for voiding this bill.");
  await getRepos().bills.void(rid(c), id, reason, staffId(c));
  return c.body(null, 204);
});

staff.post("/order-items/:id/cancel", allow(MANAGERS), async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) bad("Unknown item.");
  const b = await body<{ qty: number; reason: string }>(c);
  const reason = String(b.reason ?? "").trim();
  const qty = b.qty as number;
  if (!Number.isInteger(qty) || qty < 1 || qty > 50) bad("Choose how many to cancel.");
  if (reason.length < 2 || reason.length > 120) bad("Give a short reason, like 'out of stock'.");
  await getRepos().orders.cancelItem(rid(c), id, qty, reason, staffId(c));
  return c.body(null, 204);
});

// Sales for [from, to): a day is a day close. At most ~3 months per request.
staff.get("/reports/sales", allow(MANAGERS), async (c) => {
  const from = new Date(c.req.query("from") ?? "");
  const to = new Date(c.req.query("to") ?? "");
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 93 * 86_400_000) {
    bad("Choose a date range of up to 3 months.");
  }
  c.header("Cache-Control", "no-store");
  return c.json(await getRepos().bills.salesReport(rid(c), from.toISOString(), to.toISOString()));
});

staff.post("/orders/:id/status", async (c) => {
  const { to } = await body<{ to: OrderStatus }>(c);
  if (!to || !STATUSES.includes(to)) bad("Unknown order status.");
  const rid = c.get("membership").restaurant.id;
  const repos = getRepos();
  const order = await repos.orders.get(rid, c.req.param("id"));
  if (!order) notFound("Order not found.");
  if (to === "cancelled" && !MANAGERS.includes(c.get("membership").role)) {
    throw new HTTPException(403, { message: "Only the owner or a manager can cancel orders." });
  }
  if (!canMoveTo(order!.status, to as OrderStatus)) {
    throw new HTTPException(409, { message: "This order already moved on. Refresh to see the latest." });
  }
  await repos.orders.setStatus(rid, order!.id, to as OrderStatus, staffId(c));
  return c.body(null, 204);
});

staff.post("/orders/:id/paid", allow(CASHIERS), async (c) => {
  const { method } = await body<{ method: PaymentMethod }>(c);
  if (!method || !METHODS.includes(method)) bad("Choose how the bill was paid.");
  const rid = c.get("membership").restaurant.id;
  const repos = getRepos();
  if (!(await repos.orders.get(rid, c.req.param("id")))) notFound("Order not found.");
  await repos.orders.markPaid(rid, c.req.param("id"), method as PaymentMethod, staffId(c));
  return c.body(null, 204);
});

staff.get("/menu", async (c) => c.json(await getRepos().menu.list(c.get("membership").restaurant.id)));

staff.post("/menu/categories", allow(MANAGERS), async (c) => {
  const name = String((await body<{ name: string }>(c)).name ?? "").trim();
  if (!name || name.length > 40) bad("Enter a category name, like Starters.");
  return c.json(await getRepos().menu.addCategory(c.get("membership").restaurant.id, name), 201);
});

function readItem(b: ItemBody, partial: boolean): MenuItemPatch {
  const out: MenuItemPatch = {};
  if (b.name !== undefined || !partial) {
    const name = String(b.name ?? "").trim();
    if (!name || name.length > 80) bad("Enter the dish name.");
    out.name = name;
  }
  if (b.pricePaise !== undefined || !partial) {
    if (!Number.isInteger(b.pricePaise) || (b.pricePaise as number) < 0 || (b.pricePaise as number) > 100_000_00) bad("Enter a valid price.");
    out.pricePaise = b.pricePaise as number;
  }
  if (b.isVeg !== undefined || !partial) out.isVeg = b.isVeg !== false;
  if (b.description !== undefined) out.description = b.description ? String(b.description).slice(0, 200) : null;
  if (b.categoryId !== undefined) {
    if (b.categoryId !== null && !(typeof b.categoryId === "string" && UUID.test(b.categoryId))) bad("Unknown category.");
    out.categoryId = b.categoryId;
  }
  if (partial && b.isAvailable !== undefined) out.isAvailable = !!b.isAvailable;
  return out;
}

async function checkCategory(restaurantId: string, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const menu = await getRepos().menu.list(restaurantId);
  if (!menu.categories.some((c) => c.id === categoryId)) bad("Unknown category.");
}

staff.post("/menu/items", allow(MANAGERS), async (c) => {
  const rid = c.get("membership").restaurant.id;
  const item = readItem(await body<ItemBody>(c), false);
  await checkCategory(rid, item.categoryId);
  const created = await getRepos().menu.addItem(rid, {
    name: item.name!, pricePaise: item.pricePaise!, isVeg: item.isVeg!,
    description: item.description ?? null, categoryId: item.categoryId ?? null,
  });
  return c.json(created, 201);
});

staff.patch("/menu/items/:id", allow(MANAGERS), async (c) => {
  const rid = c.get("membership").restaurant.id;
  const patch = readItem(await body<ItemBody>(c), true);
  await checkCategory(rid, patch.categoryId);
  await getRepos().menu.updateItem(rid, c.req.param("id"), patch);
  return c.body(null, 204);
});

staff.delete("/menu/items/:id", allow(MANAGERS), async (c) => {
  await getRepos().menu.deleteItem(c.get("membership").restaurant.id, c.req.param("id"));
  return c.body(null, 204);
});

staff.patch("/restaurant", allow(MANAGERS), async (c) => {
  const patch = readRestaurantPatch(await body<UpdateRestaurantRequest>(c));
  const repos = getRepos();
  // Always the logged-in member's own restaurant; the client never chooses which one.
  await repos.restaurants.update(c.get("membership").restaurant.id, patch);
  const fresh = await repos.restaurants.getMembership(c.get("userId"));
  return c.json(fresh!.restaurant);
});

staff.get("/tables", allow(ORDER_TAKERS), async (c) => {
  const { restaurant } = c.get("membership");
  return c.json({ slug: restaurant.slug, tables: await getRepos().restaurants.listTables(restaurant.id) });
});

// ---------- staff with PINs ----------
/** Managers (login or PIN) manage cashier/kitchen/waiter. Only the owner's own login manages managers. */
function checkCanManage(c: { get: (k: "membership") => Membership }, ...roles: (StaffRole | undefined)[]) {
  if (roles.includes("manager") && c.get("membership").role !== "owner") {
    throw new HTTPException(403, { message: "Only the owner can add or change managers." });
  }
}

const readStaffName = (v: unknown) => {
  const name = String(v ?? "").trim();
  if (!name || name.length > 40) bad("Enter the staff member's name (up to 40 characters).");
  return name;
};
const readStaffRole = (v: unknown) => {
  if (!STAFF_ROLES.includes(v as StaffRole)) bad("Choose a role: manager, cashier, kitchen or waiter.");
  return v as StaffRole;
};
const readPin = (v: unknown) => {
  if (typeof v !== "string" || !isValidPin(v)) bad("PIN must be 4 to 6 digits.");
  return v as string;
};

staff.get("/members", allow(MANAGERS), async (c) => {
  return c.json({ staff: await getRepos().staff.list(c.get("membership").restaurant.id) });
});

staff.post("/members", allow(MANAGERS), async (c) => {
  const b = await body<NewStaffRequest>(c);
  const input = { name: readStaffName(b.name), role: readStaffRole(b.role), pinHash: await hashPin(readPin(b.pin)) };
  checkCanManage(c, input.role);
  return c.json(await getRepos().staff.create(c.get("membership").restaurant.id, input), 201);
});

staff.patch("/members/:id", allow(MANAGERS), async (c) => {
  const b = await body<StaffPatch>(c);
  const patch: StaffPatch = {};
  if (b.name !== undefined) patch.name = readStaffName(b.name);
  if (b.role !== undefined) patch.role = readStaffRole(b.role);
  if (b.isActive !== undefined) patch.isActive = !!b.isActive;
  if (Object.keys(patch).length === 0) bad("Nothing to update.");
  const rid = c.get("membership").restaurant.id;
  const repos = getRepos();
  const target = await repos.staff.get(rid, c.req.param("id"));
  if (!target) notFound("Staff member not found.");
  checkCanManage(c, target!.role, patch.role);
  const updated = await repos.staff.update(rid, target!.id, patch);
  if (patch.isActive === false || (patch.role && patch.role !== target!.role)) await repos.staff.revokeSessions(target!.id);
  return c.json(updated);
});

staff.post("/members/:id/pin", allow(MANAGERS), async (c) => {
  const pinHash = await hashPin(readPin((await body<{ pin: string }>(c)).pin));
  const rid = c.get("membership").restaurant.id;
  const repos = getRepos();
  const target = await repos.staff.get(rid, c.req.param("id"));
  if (!target) notFound("Staff member not found.");
  checkCanManage(c, target!.role);
  await repos.staff.setPinHash(rid, target!.id, pinHash);
  await repos.staff.revokeSessions(target!.id);
  return c.body(null, 204);
});

const WRONG_PIN = "Wrong PIN. After 5 wrong tries this name is locked for 5 minutes.";
staff.post("/pin-session", rateLimit(30, 60_000, "Too many PIN tries from this device. Wait a minute."), async (c) => {
  // The device's own login decides, not any staff member currently using it.
  if (!MANAGERS.includes(c.get("deviceRole"))) {
    throw new HTTPException(403, { message: "Staff PINs work on a device where the owner or a manager is logged in." });
  }
  const b = await body<PinSessionRequest>(c);
  const pin = typeof b.pin === "string" ? b.pin : "";
  const rid = c.get("membership").restaurant.id;
  const repos = getRepos();
  const claim = await repos.staff.claimPinAttempt(String(b.staffId ?? ""));
  if (!claim || claim.restaurantId !== rid) {
    // Unknown, inactive or locked. Locked is the only case staff can hit by mistake, so say so.
    throw new HTTPException(423, { message: "This name is locked for a few minutes after wrong PINs, or no longer active. Ask the owner." });
  }
  // 400, not 401: clients treat 401 as "logged out".
  if (!isValidPin(pin) || !(await verifyPin(pin, claim.pinHash))) bad(WRONG_PIN);
  const member = (await repos.staff.get(rid, b.staffId!))!;
  await repos.staff.pinSucceeded(member.id);
  const token = newToken();
  const expiresAt = new Date(Date.now() + STAFF_SESSION_MS).toISOString();
  await repos.staff.createSession(member.id, hashToken(token), expiresAt);
  return c.json({ token, expiresAt, staff: member });
});

app.route("/staff", staff);
