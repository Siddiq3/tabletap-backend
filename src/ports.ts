// Ports: what the API needs from storage and login. One folder in src/adapters per backend.
import type {
  AuthSession, DiningTable, Menu, MenuCategory, MenuItem, Membership, NewMenuItem, NewRestaurant,
  LoginIdentifier, Order, OrderStatus, PaymentMethod, PlaceOrderInput, Restaurant, StaffMember, StaffRole, UserProfile,
} from "./contract";

export interface RestaurantRepo {
  getBySlug(slug: string): Promise<Restaurant | null>;
  getMembership(userId: string): Promise<Membership | null>;
  slugTaken(slug: string): Promise<boolean>;
  create(input: NewRestaurant, ownerUserId: string): Promise<string>;
  update(restaurantId: string, patch: Partial<Pick<Restaurant, "name" | "address" | "upiId" | "taxPercent">>): Promise<void>;
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

export interface OrderRepo {
  place(input: PlaceOrderInput): Promise<{ orderId: string; orderNo: number; totalPaise: number }>;
  get(restaurantId: string, orderId: string): Promise<Order | null>;
  /** Open orders of any age, plus everything from today (IST). */
  listBoard(restaurantId: string): Promise<Order[]>;
  /** staffId: the PIN staff member acting, or null for the owner/manager's own login. */
  setStatus(restaurantId: string, orderId: string, status: OrderStatus, staffId: string | null): Promise<void>;
  markPaid(restaurantId: string, orderId: string, method: PaymentMethod, staffId: string | null): Promise<void>;
}

export interface ProfileRepo {
  find(id: LoginIdentifier): Promise<(UserProfile & { userId: string }) | null>;
  get(userId: string): Promise<UserProfile | null>;
  /** Throws DomainError USERNAME_TAKEN / EMAIL_TAKEN / PHONE_TAKEN on a clash. */
  create(userId: string, profile: UserProfile): Promise<void>;
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

export interface Repos {
  restaurants: RestaurantRepo;
  menu: MenuRepo;
  orders: OrderRepo;
  profiles: ProfileRepo;
  staff: StaffRepo;
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
  /** Silent when the email has no account. */
  sendPasswordReset(email: string): Promise<void>;
}
