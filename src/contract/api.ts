// CONTRACT FILE — identical copies live in tabletap-backend, tabletap-web and tabletap-app.
// When you change it, make the same change in the other two repos in the same week,
// and bump CONTRACT_VERSION in index.ts.

// The API contract between backend, web and app.
// Web and app both talk to the backend only through createApiClient, so the backend can move
// (Supabase today, AWS later) without touching either client.
import type {
  DiningTable, Membership, Menu, MenuCategory, MenuItem, NewMenuItem, Order, OrderStatus, PaymentMethod, Restaurant,
  Bill, SalesReport, StaffCall, StaffMember, StaffRole, UserProfile,
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

/** Staff adding items: to a table (its open bill), to a specific bill, or a new takeaway. Exactly one target. v8. */
export interface StaffOrderRequest {
  tableId?: string;
  billId?: string;
  takeaway?: { customerName?: string; customerPhone?: string };
  items: { menuItemId: string; qty: number }[];
  note?: string;
}

/** One payment towards a bill; several make a split. expectedTotalPaise is the total the cashier saw. v8. */
export interface BillPaymentRequest {
  method: PaymentMethod;
  amountPaise: number;
  expectedTotalPaise: number;
}

/** Managers: discount (needs a reason) and waiving the service charge. v8. */
export interface BillPatch {
  discountPaise?: number;
  discountReason?: string;
  serviceChargeOn?: boolean;
}

export interface PlaceOrderResponse {
  /** v8: the bill the order joined. */
  billId?: string;
  orderId: string;
  orderNo: number;
  totalPaise: number;
}

/** The guest's whole table bill while their order is still on it; null once settled. Added in v7. */
export interface PublicBillResponse {
  bill: Bill | null;
}

export interface PublicOrderResponse {
  restaurant: PublicRestaurant;
  order: Order;
}

export interface MeResponse {
  userId: string;
  membership: Membership | null;
  /** Null for accounts made before v3 (email-code logins). */
  profile?: UserProfile | null;
}

// ---------- owner/manager login ----------
/** Email and/or phone: at least one is required. */
export interface SignupRequest {
  fullName: string;
  username: string;
  password: string;
  email?: string;
  phone?: string;
}

export interface LoginRequest {
  /** Email, phone or username; the backend works out which. */
  identifier: string;
  password: string;
}

/** Hand both tokens to the login provider (lib/auth.ts setSession). */
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse {
  session: AuthSession;
}

export interface VerifyEmailRequest {
  code: string;
}

/** After a code is sent: when "Resend code" can be tapped again. */
export interface ResendCodeResponse {
  retryAfterSeconds: number;
}

export interface ForgotPasswordResponse {
  /** false → the account has no real email; show `message` (contact support). */
  emailSent: boolean;
  message: string;
}

// ---------- staff with PINs ----------
export interface StaffListResponse {
  staff: StaffMember[];
}

export interface NewStaffRequest {
  name: string;
  role: StaffRole;
  pin: string;
}

/** Send only what changed. isActive: false deactivates and ends their sessions. */
export interface StaffPatch {
  name?: string;
  role?: StaffRole;
  isActive?: boolean;
}

export interface PinSessionRequest {
  staffId: string;
  pin: string;
}

/** Send `token` as X-Staff-Session on every call while this staff member is working. */
export interface PinSessionResponse {
  token: string;
  expiresAt: string;
  staff: StaffMember;
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
  /** v8 */
  gstin?: string;
  fssai?: string;
  serviceChargePercent?: number;
  packagingPaise?: number;
}

export interface TablesResponse {
  slug: string;
  tables: DiningTable[];
}

export type MenuItemPatch = Partial<NewMenuItem & { isAvailable: boolean }>;

export interface ApiErrorBody {
  error: string;
  code?: string;
  /** 429 on "Resend code": seconds until it's allowed again. */
  retryAfterSeconds?: number;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public retryAfterSeconds?: number) {
    super(message);
  }
}

const enc = encodeURIComponent;

/** Error code when the X-Staff-Session token is expired/revoked: go back to "Who's working?", don't log out. */
export const STAFF_SESSION_ERROR = "STAFF_SESSION";
/** Error code (403) when the account's email isn't verified yet: show the "Check your email" screen. */
export const EMAIL_UNVERIFIED_ERROR = "EMAIL_UNVERIFIED";

/**
 * getStaffSession: the active PIN session token on a shared device, if any. When it returns a token,
 * calls act as that staff member (their role decides permissions).
 */
export function createApiClient(
  baseUrl: string,
  getToken: () => Promise<string | null>,
  getStaffSession: () => string | null = () => null,
) {
  const base = baseUrl.replace(/\/+$/, "");

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getToken();
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const staffSession = getStaffSession();
    if (staffSession) headers["X-Staff-Session"] = staffSession;

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
      throw new ApiError(res.status, err.error ?? "Something went wrong. Try again.", err.code, err.retryAfterSeconds);
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
    publicBill: (slug: string, orderId: string) =>
      call<PublicBillResponse>("GET", `/public/r/${enc(slug)}/orders/${enc(orderId)}/bill`),

    callStaff: (slug: string, tableId: string) => call<{ call: StaffCall }>("POST", `/public/r/${enc(slug)}/staff-calls`, { tableId }),
    staffCalls: () => call<{ calls: StaffCall[] }>("GET", "/staff/calls"),
    resolveStaffCall: (id: string) => call<null>("POST", `/staff/calls/${enc(id)}/resolve`),

    // owner/manager login (no token needed)
    signup: (body: SignupRequest) => call<AuthResponse>("POST", "/auth/signup", body),
    login: (body: LoginRequest) => call<AuthResponse>("POST", "/auth/login", body),
    forgotPassword: (identifier: string) => call<ForgotPasswordResponse>("POST", "/auth/forgot-password", { identifier }),
    // logged in, email not verified yet
    verifyEmail: (code: string) => call<null>("POST", "/auth/verify-email", { code } satisfies VerifyEmailRequest),
    resendCode: () => call<ResendCodeResponse>("POST", "/auth/resend-code"),

    // signed-in
    me: () => call<MeResponse>("GET", "/me"),
    createRestaurant: (body: CreateRestaurantRequest) => call<{ restaurantId: string }>("POST", "/restaurants", body),

    // staff of a restaurant
    board: () => call<{ orders: Order[] }>("GET", "/staff/orders"),
    moveOrder: (orderId: string, to: OrderStatus) => call<null>("POST", `/staff/orders/${enc(orderId)}/status`, { to }),
    markPaid: (orderId: string, method: PaymentMethod) => call<null>("POST", `/staff/orders/${enc(orderId)}/paid`, { method }),
    // bills (v8): rounds from QR and staff, split payments, discounts, tables, takeaway, cancellations, reports
    addOrder: (body: StaffOrderRequest) => call<PlaceOrderResponse>("POST", "/staff/orders", body),
    bills: () => call<{ bills: Bill[] }>("GET", "/staff/bills"),
    bill: (billId: string) => call<{ bill: Bill }>("GET", `/staff/bills/${enc(billId)}`),
    payBill: (billId: string, body: BillPaymentRequest) => call<{ bill: Bill }>("POST", `/staff/bills/${enc(billId)}/payments`, body),
    updateBill: (billId: string, patch: BillPatch) => call<{ bill: Bill }>("PATCH", `/staff/bills/${enc(billId)}`, patch),
    moveBill: (billId: string, tableId: string) => call<null>("POST", `/staff/bills/${enc(billId)}/move`, { tableId }),
    mergeBill: (billId: string, intoBillId: string) => call<null>("POST", `/staff/bills/${enc(billId)}/merge`, { intoBillId }),
    voidBill: (billId: string, reason: string) => call<null>("POST", `/staff/bills/${enc(billId)}/void`, { reason }),
    cancelItem: (orderItemId: string, body: { qty: number; reason: string }) => call<null>("POST", `/staff/order-items/${enc(orderItemId)}/cancel`, body),
    salesReport: (fromIso: string, toIso: string) => call<SalesReport>("GET", `/staff/reports/sales?from=${enc(fromIso)}&to=${enc(toIso)}`),
    menu: () => call<Menu>("GET", "/staff/menu"),
    addCategory: (name: string) => call<MenuCategory>("POST", "/staff/menu/categories", { name }),
    addItem: (item: NewMenuItem) => call<MenuItem>("POST", "/staff/menu/items", item),
    updateItem: (itemId: string, patch: MenuItemPatch) => call<null>("PATCH", `/staff/menu/items/${enc(itemId)}`, patch),
    deleteItem: (itemId: string) => call<null>("DELETE", `/staff/menu/items/${enc(itemId)}`),
    tables: () => call<TablesResponse>("GET", "/staff/tables"),
    updateRestaurant: (body: UpdateRestaurantRequest) => call<Restaurant>("PATCH", "/staff/restaurant", body),

    // staff with PINs (owner/manager device)
    staffList: () => call<StaffListResponse>("GET", "/staff/members"),
    createStaff: (body: NewStaffRequest) => call<StaffMember>("POST", "/staff/members", body),
    updateStaff: (staffId: string, patch: StaffPatch) => call<StaffMember>("PATCH", `/staff/members/${enc(staffId)}`, patch),
    deactivateStaff: (staffId: string) => call<StaffMember>("PATCH", `/staff/members/${enc(staffId)}`, { isActive: false }),
    setStaffPin: (staffId: string, pin: string) => call<null>("POST", `/staff/members/${enc(staffId)}/pin`, { pin }),
    startPinSession: (body: PinSessionRequest) => call<PinSessionResponse>("POST", "/staff/pin-session", body),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
