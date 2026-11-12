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
  /** Printed on tax invoices. Added in v8. */
  gstin?: string | null;
  fssai?: string | null;
  /** Dine-in service charge % (0 = none) and takeaway packaging charge. Added in v8. */
  serviceChargePercent?: number;
  packagingPaise?: number;
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
  /** order_items id, to cancel one dish. Added in v8 (absent on merged bill lines). */
  id?: string;
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
  /** v8: the bill this round belongs to; "qr" = guest ordered, "staff" = added by staff (placedByName when a PIN user did it). */
  billId?: string | null;
  source?: "qr" | "staff";
  placedByName?: string | null;
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

export type BillKind = "dine_in" | "takeaway";
export type BillStatus = "open" | "settled" | "void";

export interface BillPayment {
  id: string;
  method: PaymentMethod;
  amountPaise: number;
  createdAt: string;
}

/**
 * One table visit (or one takeaway) = one bill with its own invoice number. Every round joins it:
 * guest QR orders and items staff add. Split payments close it when the total is covered. Added in v8.
 */
export interface Bill {
  id: string;
  invoiceNo: number;
  kind: BillKind;
  status: BillStatus;
  tableId: string | null;
  tableLabel: string | null;
  customerName: string | null;
  customerPhone: string | null;
  /** Non-cancelled rounds, oldest first. */
  orders: Order[];
  /** The same dish at the same price merged across rounds (2 + 1 Paneer = 3 Paneer). */
  lines: OrderLine[];
  subtotalPaise: number;
  discountPaise: number;
  discountReason: string | null;
  serviceChargeOn: boolean;
  serviceChargePaise: number;
  packagingPaise: number;
  taxPaise: number;
  /** GST split for the invoice (intra-state: half CGST, half SGST). */
  cgstPaise: number;
  sgstPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  paidPaise: number;
  duePaise: number;
  payments: BillPayment[];
  openedAt: string;
  settledAt: string | null;
  voidReason: string | null;
}

/** Settled bills in a period (a day = day close). Added in v8. */
export interface SalesReport {
  bills: number;
  dineIn: number;
  takeaway: number;
  subtotalPaise: number;
  discountPaise: number;
  serviceChargePaise: number;
  packagingPaise: number;
  taxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  payments: { method: PaymentMethod; amountPaise: number; count: number }[];
  topItems: { name: string; qty: number; amountPaise: number }[];
  cancelledItems: number;
  cancelledPaise: number;
  voidBills: number;
  firstInvoice: number | null;
  lastInvoice: number | null;
}

/** A guest asking for assistance at a table. Resolved calls leave the staff inbox. */
export interface StaffCall {
  id: string;
  tableId: string;
  tableLabel: string;
  createdAt: string;
  resolvedAt: string | null;
}
