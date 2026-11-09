import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import {
  CONTRACT_VERSION, DomainError, canMoveTo, slugify,
  type CreateRestaurantRequest, type Membership, type MenuItemPatch, type NewMenuItem, type OrderStatus,
  type PaymentMethod, type PlaceOrderRequest, type PublicRestaurant, type Restaurant, type Role,
} from "./contract";
import { getAuthVerifier, getRepos } from "./adapters";
import { rateLimit } from "./rate-limit";

type Env = { Variables: { userId: string; membership: Membership } };

const UUID = /^[0-9a-f-]{36}$/i;
const MANAGERS: Role[] = ["owner", "manager"];
const CASHIERS: Role[] = ["owner", "manager", "cashier"];
const STATUSES: OrderStatus[] = ["new", "preparing", "ready", "served", "cancelled"];
const METHODS: PaymentMethod[] = ["upi", "cash", "card", "online"];

function bad(message: string): never {
  throw new HTTPException(400, { message });
}
function notFound(message = "Not found."): never {
  throw new HTTPException(404, { message });
}
type ItemBody = Partial<NewMenuItem & { isAvailable: boolean }>;
const body = async <T>(c: { req: { json: () => Promise<unknown> } }): Promise<Partial<T>> =>
  ((await c.req.json().catch(() => null)) ?? {}) as Partial<T>;

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
    allowHeaders: ["Content-Type", "Authorization"],
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

app.post("/public/orders", rateLimit(15, 60_000), async (c) => {
  const b = await body<PlaceOrderRequest>(c);
  const items = Array.isArray(b.items) ? b.items : [];
  const valid =
    typeof b.slug === "string" &&
    typeof b.tableId === "string" && UUID.test(b.tableId) &&
    items.length > 0 && items.length <= 60 &&
    items.every((i) => i && typeof i.menuItemId === "string" && UUID.test(i.menuItemId) && Number.isInteger(i.qty) && i.qty >= 1 && i.qty <= 50);
  if (!valid) bad("Your cart could not be read. Refresh the page and try again.");

  const repos = getRepos();
  const restaurant = await repos.restaurants.getBySlug(b.slug as string);
  if (!restaurant) notFound("Restaurant not found.");

  const placed = await repos.orders.place({
    restaurantId: restaurant!.id,
    tableId: b.tableId as string,
    items: items.map((i) => ({ menuItemId: i.menuItemId, qty: i.qty })),
    note: typeof b.note === "string" ? b.note.slice(0, 300) : "",
  });
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

// ---------- signed-in ----------
const requireUser = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const userId = token ? await getAuthVerifier().verify(token) : null;
  if (!userId) throw new HTTPException(401, { message: "Please log in again." });
  c.set("userId", userId);
  await next();
});

const requireMember = createMiddleware<Env>(async (c, next) => {
  const membership = await getRepos().restaurants.getMembership(c.get("userId"));
  if (!membership) throw new HTTPException(403, { message: "Set up your restaurant first." });
  if (membership.restaurant.plan === "suspended") {
    throw new HTTPException(402, { message: "Your plan is paused. Renew your subscription to continue." });
  }
  c.set("membership", membership);
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
  const membership = await getRepos().restaurants.getMembership(c.get("userId"));
  return c.json({ userId: c.get("userId"), membership });
});

app.post("/restaurants", requireUser, async (c) => {
  const b = await body<CreateRestaurantRequest>(c);
  const name = String(b.name ?? "").trim();
  const slug = slugify(String(b.slug ?? "") || name);
  const upiId = String(b.upiId ?? "").trim();
  const tableCount = Number(b.tableCount);

  if (name.length < 2) bad("Enter your restaurant's name.");
  if (slug.length < 3) bad("The menu link needs at least 3 letters or numbers.");
  if (!Number.isInteger(tableCount) || tableCount < 1 || tableCount > 200) bad("Tables must be between 1 and 200.");
  if (upiId && !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upiId)) bad("UPI ID looks wrong. It should look like name@okaxis.");

  const repos = getRepos();
  if (await repos.restaurants.getMembership(c.get("userId"))) {
    throw new HTTPException(409, { message: "You already have a restaurant." });
  }
  const restaurantId = await repos.restaurants.create({ name, slug, upiId: upiId || null, tableCount }, c.get("userId"));
  return c.json({ restaurantId }, 201);
});

// ---------- restaurant staff ----------
const staff = new Hono<Env>();
staff.use("*", requireUser, requireMember);

staff.get("/orders", async (c) => {
  const orders = await getRepos().orders.listBoard(c.get("membership").restaurant.id);
  return c.json({ orders });
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
  await repos.orders.setStatus(rid, order!.id, to as OrderStatus);
  return c.body(null, 204);
});

staff.post("/orders/:id/paid", allow(CASHIERS), async (c) => {
  const { method } = await body<{ method: PaymentMethod }>(c);
  if (!method || !METHODS.includes(method)) bad("Choose how the bill was paid.");
  const rid = c.get("membership").restaurant.id;
  const repos = getRepos();
  if (!(await repos.orders.get(rid, c.req.param("id")))) notFound("Order not found.");
  await repos.orders.markPaid(rid, c.req.param("id"), method as PaymentMethod);
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

staff.get("/tables", allow(MANAGERS), async (c) => {
  const { restaurant } = c.get("membership");
  return c.json({ slug: restaurant.slug, tables: await getRepos().restaurants.listTables(restaurant.id) });
});

app.route("/staff", staff);
