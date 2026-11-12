// Ports: what the API needs from storage and login. One folder in src/adapters per backend.
import type {
  AuthSession, Bill, DiningTable, Menu, MenuCategory, MenuItem, Membership, NewMenuItem, NewRestaurant,
  LoginIdentifier, Order, OrderStatus, PaymentMethod, Restaurant, SalesReport, StaffCall, StaffMember, StaffRole, UserProfile,
} from "./contract";

export interface RestaurantRepo {
  getBySlug(slug: string): Promise<Restaurant | null>;
  getMembership(userId: string): Promise<Membership | null>;
  slugTaken(slug: string): Promise<boolean>;
  create(input: NewRestaurant, ownerUserId: string): Promise<string>;
  update(restaurantId: string, patch: Partial<Pick<Restaurant, "name" | "address" | "upiId" | "taxPercent" | "gstin" | "fssai" | "serviceChargePercent" | "packagingPaise">>): Promise<void>;
  listTables(restaurantId: string): Promise<DiningTable[]>;
  getTable(restaurantId: string, tableId: string): Promise<DiningTable | null>;
  addTables(restaurantId: string, labels: string[]): Promise<void>;
}

export interface MenuRepo {
  list(restaurantId: string, opts?: { availableOnly?: boolean }): Promise<Menu>;
  addCategory(restaurantId: string, name: string): Promise<MenuCategory>;
  addItem(restaurantId: string, item: NewMenuItem): Promise<MenuItem>;
  updateItem(restaurantId: string, itemId: string, patch: Partial<NewMenuItem & { isAvailable: boolean }>): Promise<void>;
  deleteItem(restaurantId: string, itemId: string): Promise<void>;
}

/** Where an order goes: a table (its open bill, created if needed), a specific open bill, or a new takeaway bill. */
export interface NewOrder {
  restaurantId: string;
  tableId?: string;
  billId?: string;
  takeaway?: { customerName?: string; customerPhone?: string };
  items: { menuItemId: string; qty: number }[];
  note?: string;
  source: "qr" | "staff";
  /** PIN staff member who added it; null for guests and the owner/manager's own login. */
  staffId: string | null;
}

export interface OrderRepo {
  place(input: NewOrder): Promise<{ orderId: string; orderNo: number; totalPaise: number; billId: string }>;
  get(restaurantId: string, orderId: string): Promise<Order | null>;
  /** Open orders of any age, plus everything from today (IST). */
  listBoard(restaurantId: string): Promise<Order[]>;
  /** staffId: the PIN staff member acting, or null for the owner/manager's own login. */
  setStatus(restaurantId: string, orderId: string, status: OrderStatus, staffId: string | null): Promise<void>;
  /** Pays one round against its bill (the last unpaid round settles the rest and closes the bill). */
  markPaid(restaurantId: string, orderId: string, method: PaymentMethod, staffId: string | null): Promise<void>;
  /** Throws DomainError REASON_REQUIRED / ITEM_NOT_FOUND / INVALID_QTY / BILL_CLOSED. */
  cancelItem(restaurantId: string, orderItemId: string, qty: number, reason: string, staffId: string | null): Promise<void>;
}

export interface BillRepo {
  listOpen(restaurantId: string): Promise<Bill[]>;
  get(restaurantId: string, billId: string): Promise<Bill | null>;
  /** The open bill containing this order, or null once it is closed. */
  openBillForOrder(restaurantId: string, orderId: string): Promise<Bill | null>;
  /** Throws DomainError BILL_CHANGED (total moved), INVALID_PAYMENT_AMOUNT, BILL_CLOSED. */
  pay(restaurantId: string, billId: string, p: { method: PaymentMethod; amountPaise: number; expectedTotalPaise: number }, staffId: string | null): Promise<void>;
  /** False when the bill is not open. */
  update(restaurantId: string, billId: string, patch: { discountPaise?: number; discountReason?: string | null; serviceChargeOn?: boolean }): Promise<boolean>;
  move(restaurantId: string, billId: string, tableId: string): Promise<void>;
  merge(restaurantId: string, fromBillId: string, intoBillId: string, staffId: string | null): Promise<void>;
  void(restaurantId: string, billId: string, reason: string, staffId: string | null): Promise<void>;
  salesReport(restaurantId: string, fromIso: string, toIso: string): Promise<SalesReport>;
}

export interface ProfileRepo {
  find(id: LoginIdentifier): Promise<(UserProfile & { userId: string }) | null>;
  get(userId: string): Promise<UserProfile | null>;
  /** Throws DomainError USERNAME_TAKEN / EMAIL_TAKEN / PHONE_TAKEN on a clash. A new email starts unverified. */
  create(userId: string, profile: Omit<UserProfile, "emailVerified">): Promise<void>;
  markEmailVerified(userId: string): Promise<void>;
}

/** 6-digit email codes. One row per code sent; only the newest is live. */
export interface EmailCodeRepo {
  /** Stores a new code (it replaces any older one) and drops rows older than a day. */
  create(userId: string, codeHash: string, expiresAt: string): Promise<void>;
  /** created_at of codes sent since `sinceIso`, newest first (for resend limits). */
  sentSince(userId: string, sinceIso: string): Promise<string[]>;
  /** Atomically counts one attempt on the newest live code. Null = none, expired or 5 attempts used. */
  claimAttempt(userId: string): Promise<{ codeHash: string; attemptsLeft: number } | null>;
  deleteAll(userId: string): Promise<void>;
}

export interface StaffRepo {
  list(restaurantId: string): Promise<StaffMember[]>;
  get(restaurantId: string, staffId: string): Promise<StaffMember | null>;
  create(restaurantId: string, input: { name: string; role: StaffRole; pinHash: string }): Promise<StaffMember>;
  update(restaurantId: string, staffId: string, patch: Partial<Pick<StaffMember, "name" | "role" | "isActive">>): Promise<StaffMember>;
  /** New PIN; also clears failed attempts and any lock. */
  setPinHash(restaurantId: string, staffId: string, pinHash: string): Promise<void>;
  /** Atomically counts one attempt (locks on the 5th). Null when unknown, inactive or locked. */
  claimPinAttempt(staffId: string): Promise<{ pinHash: string; restaurantId: string } | null>;
  /** Correct PIN: reset the counter and lock. */
  pinSucceeded(staffId: string): Promise<void>;
  createSession(staffId: string, tokenHash: string, expiresAt: string): Promise<void>;
  /** Only unexpired, unrevoked sessions of active staff. */
  findSession(tokenHash: string): Promise<{ staff: StaffMember; restaurantId: string } | null>;
  revokeSessions(staffId: string): Promise<void>;
}

export interface StaffCallRepo {
  request(restaurantId: string, tableId: string): Promise<StaffCall>;
  listPending(restaurantId: string): Promise<StaffCall[]>;
  resolve(restaurantId: string, callId: string, staffId: string | null): Promise<boolean>;
}

export interface Repos {
  bills: BillRepo;
  staffCalls: StaffCallRepo;
  restaurants: RestaurantRepo;
  menu: MenuRepo;
  orders: OrderRepo;
  profiles: ProfileRepo;
  staff: StaffRepo;
  emailCodes: EmailCodeRepo;
}

/** Turns a login token from web or app into a user id, or null if invalid/expired. */
export interface AuthVerifier {
  verify(token: string): Promise<string | null>;
}

/**
 * Owner/manager logins. One method per way of logging in, so OTP later is one more method
 * (e.g. sendOtp/verifyOtp) without touching the password ones.
 */
export interface AuthProvider extends AuthVerifier {
  /** email null → the provider gets an internal address nobody sees. Returns the new user id. Throws DomainError EMAIL_TAKEN. */
  createUser(input: { email: string | null; password: string }): Promise<string>;
  deleteUser(userId: string): Promise<void>;
  /** Null on any failure (wrong password, unknown user); never says which. */
  signInWithPassword(who: { userId: string } | { email: string }, password: string): Promise<AuthSession | null>;
  /** Reset link for the Mailer to send (the provider sends nothing). Null when the email has no account. */
  createPasswordResetLink(email: string): Promise<string | null>;
}

/** Outgoing email. The provider's own emails are never used, so moving off Supabase changes nothing here. */
export interface Mailer {
  sendVerificationCode(to: string, code: string): Promise<void>;
  sendPasswordReset(to: string, link: string): Promise<void>;
}
