// CONTRACT FILE — identical copies live in tabletap-backend, tabletap-web and tabletap-app.
// When you change it, make the same change in the other two repos in the same week,
// and bump CONTRACT_VERSION in index.ts.

export type Role = "owner" | "manager" | "cashier" | "kitchen" | "waiter";
/** Staff without an account (name + PIN). Owners always log in with a password. */
export type StaffRole = Exclude<Role, "owner">;
export type OrderStatus = "new" | "preparing" | "ready" | "served" | "cancelled";
export type PaymentStatus = "unpaid" | "paid" | "refunded";
export type PaymentMethod = "upi" | "cash" | "card" | "online";

export interface Restaurant {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  upiId: string | null;
  taxPercent: number;
  plan: string;
}

export interface Membership {
  restaurant: Restaurant;
  role: Role;
}

export interface DiningTable {
  id: string;
  label: string;
  seats: number;
  isActive: boolean;
}

export interface MenuCategory {
  id: string;
  name: string;
  sortOrder: number;
}

export interface MenuItem {
  id: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  pricePaise: number;
  isVeg: boolean;
  isAvailable: boolean;
  imageUrl: string | null;
}

export interface Menu {
  categories: MenuCategory[];
  items: MenuItem[];
}

export interface NewMenuItem {
  categoryId: string | null;
  name: string;
  description: string | null;
  pricePaise: number;
  isVeg: boolean;
}

export interface OrderLine {
  name: string;
  isVeg: boolean;
  unitPricePaise: number;
  qty: number;
}

export interface Order {
  id: string;
  orderNo: number;
  tableId: string | null;
  tableLabel: string | null;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod | null;
  note: string | null;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  createdAt: string;
  lines: OrderLine[];
  /** Staff member who marked it paid; null when the owner/manager did it with their own login. Added in v3. */
  paidByName?: string | null;
}

export interface PlaceOrderInput {
  restaurantId: string;
  tableId: string;
  items: { menuItemId: string; qty: number }[];
  note?: string;
}

export interface NewRestaurant {
  name: string;
  slug: string;
  upiId: string | null;
  tableCount: number;
}

export interface StaffMember {
  id: string;
  name: string;
  role: StaffRole;
  isActive: boolean;
}

export interface UserProfile {
  fullName: string;
  username: string;
  email: string | null;
  phone: string | null;
  /** False until the 6-digit email code is entered. Phone-only accounts: true (nothing to verify yet). Added in v4. */
  emailVerified: boolean;
}

/** A guest asking for assistance at a table. Resolved calls leave the staff inbox. */
export interface StaffCall {
  id: string;
  tableId: string;
  tableLabel: string;
  createdAt: string;
  resolvedAt: string | null;
}
