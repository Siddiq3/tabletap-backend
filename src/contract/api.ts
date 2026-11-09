// CONTRACT FILE — identical copies live in tabletap-backend, tabletap-web and tabletap-app.
// When you change it, make the same change in the other two repos in the same week,
// and bump CONTRACT_VERSION in index.ts.

// The API contract between backend, web and app.
// Web and app both talk to the backend only through createApiClient, so the backend can move
// (Supabase today, AWS later) without touching either client.
import type {
  DiningTable, Membership, Menu, MenuCategory, MenuItem, NewMenuItem, Order, OrderStatus, PaymentMethod, Restaurant,
} from "./types";

export interface PublicRestaurant {
  name: string;
  slug: string;
  address: string | null;
  taxPercent: number;
  upiId: string | null;
}

export interface PublicMenuResponse {
  restaurant: PublicRestaurant;
  table: { id: string; label: string } | null;
  menu: Menu;
}

export interface PlaceOrderRequest {
  slug: string;
  tableId: string;
  note?: string;
  items: { menuItemId: string; qty: number }[];
}

export interface PlaceOrderResponse {
  orderId: string;
  orderNo: number;
  totalPaise: number;
}

export interface PublicOrderResponse {
  restaurant: PublicRestaurant;
  order: Order;
}

export interface MeResponse {
  userId: string;
  membership: Membership | null;
}

export interface CreateRestaurantRequest {
  name: string;
  slug: string;
  upiId?: string;
  tableCount: number;
}

/** Owner/manager settings. Send only what changed; an empty string removes address or UPI ID. */
export interface UpdateRestaurantRequest {
  name?: string;
  address?: string;
  upiId?: string;
  taxPercent?: number;
}

export interface TablesResponse {
  slug: string;
  tables: DiningTable[];
}

export type MenuItemPatch = Partial<NewMenuItem & { isAvailable: boolean }>;

export interface ApiErrorBody {
  error: string;
  code?: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

const enc = encodeURIComponent;

export function createApiClient(baseUrl: string, getToken: () => Promise<string | null>) {
  const base = baseUrl.replace(/\/+$/, "");

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getToken();
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch {
      throw new ApiError(0, "No internet connection. Check your network and try again.");
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const err = (data ?? {}) as Partial<ApiErrorBody>;
      throw new ApiError(res.status, err.error ?? "Something went wrong. Try again.", err.code);
    }
    return data as T;
  }

  return {
    // guests (no login)
    publicMenu: (slug: string, tableId?: string) =>
      call<PublicMenuResponse>("GET", `/public/r/${enc(slug)}${tableId ? `?t=${enc(tableId)}` : ""}`),
    placeOrder: (body: PlaceOrderRequest) => call<PlaceOrderResponse>("POST", "/public/orders", body),
    publicOrder: (slug: string, orderId: string) =>
      call<PublicOrderResponse>("GET", `/public/r/${enc(slug)}/orders/${enc(orderId)}`),

    // signed-in
    me: () => call<MeResponse>("GET", "/me"),
    createRestaurant: (body: CreateRestaurantRequest) => call<{ restaurantId: string }>("POST", "/restaurants", body),

    // staff of a restaurant
    board: () => call<{ orders: Order[] }>("GET", "/staff/orders"),
    moveOrder: (orderId: string, to: OrderStatus) => call<null>("POST", `/staff/orders/${enc(orderId)}/status`, { to }),
    markPaid: (orderId: string, method: PaymentMethod) => call<null>("POST", `/staff/orders/${enc(orderId)}/paid`, { method }),
    menu: () => call<Menu>("GET", "/staff/menu"),
    addCategory: (name: string) => call<MenuCategory>("POST", "/staff/menu/categories", { name }),
    addItem: (item: NewMenuItem) => call<MenuItem>("POST", "/staff/menu/items", item),
    updateItem: (itemId: string, patch: MenuItemPatch) => call<null>("PATCH", `/staff/menu/items/${enc(itemId)}`, patch),
    deleteItem: (itemId: string) => call<null>("DELETE", `/staff/menu/items/${enc(itemId)}`),
    tables: () => call<TablesResponse>("GET", "/staff/tables"),
    updateRestaurant: (body: UpdateRestaurantRequest) => call<Restaurant>("PATCH", "/staff/restaurant", body),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
