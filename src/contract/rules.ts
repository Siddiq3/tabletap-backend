// CONTRACT FILE — identical copies live in tabletap-backend, tabletap-web and tabletap-app.
// When you change it, make the same change in the other two repos in the same week,
// and bump CONTRACT_VERSION in index.ts.

import type { Bill, BillKind, BillPayment, BillStatus, Order, OrderLine, OrderStatus } from "./types";

export class DomainError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export const ERROR_MESSAGES: Record<string, string> = {
  STAFF_CALL_COOLDOWN: "Please wait 30 seconds before calling staff again.",
  EMPTY_ORDER: "Your cart is empty. Add a dish first.",
  INVALID_TABLE: "This table QR is not active. Ask the staff for help.",
  ITEM_UNAVAILABLE: "A dish in your cart just sold out. Remove it and try again.",
  RESTAURANT_UNAVAILABLE: "This restaurant is not taking orders right now.",
  SLUG_TAKEN: "That link is already used by another restaurant. Try another.",
  USERNAME_TAKEN: "That username is taken. Try another.",
  EMAIL_TAKEN: "An account with this email already exists. Log in instead.",
  PHONE_TAKEN: "An account with this phone number already exists. Log in instead.",
  BILL_CHANGED: "New items were added to this table. Check the bill again before settling.",
  BILL_EMPTY: "This bill has nothing to pay yet.",
  BILL_CLOSED: "This bill is already closed. Refresh to see the latest.",
  BILL_HAS_PAYMENTS: "This bill already has payments, so it can't be voided.",
  TABLE_BUSY: "That table already has an open bill. Merge the bills instead.",
  INVALID_PAYMENT_AMOUNT: "Enter an amount up to the balance due.",
  REASON_REQUIRED: "Give a short reason.",
  ITEM_NOT_FOUND: "That item is no longer on the order.",
  INVALID_QTY: "Choose how many to cancel.",
};

/** Same dish at the same price merged across rounds. */
export function mergeLines(orders: Order[]): OrderLine[] {
  const lines = new Map<string, OrderLine>();
  for (const l of orders.flatMap((o) => o.lines)) {
    const key = `${l.name}|${l.unitPricePaise}|${l.isVeg}`;
    const prev = lines.get(key);
    lines.set(key, { name: l.name, isVeg: l.isVeg, unitPricePaise: l.unitPricePaise, qty: (prev?.qty ?? 0) + l.qty });
  }
  return [...lines.values()];
}

export interface BillAmounts {
  subtotalPaise: number;
  discountPaise: number;
  serviceChargePaise: number;
  packagingPaise: number;
  taxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
}

/**
 * Mirror of the bill_amounts view (migration 0011), for previews and the demo; the database is the
 * source of truth. taxable = subtotal − discount + service (dine-in) + packaging (takeaway);
 * GST on taxable; total rounded to the nearest rupee.
 */
export function computeBillAmounts(i: {
  subtotalPaise: number; discountPaise: number; kind: BillKind; serviceChargeOn: boolean;
  serviceChargePercent: number; packagingPaise: number; taxPercent: number;
}): BillAmounts {
  const discount = Math.min(i.discountPaise, i.subtotalPaise);
  const service = i.kind === "dine_in" && i.serviceChargeOn ? Math.round(((i.subtotalPaise - discount) * i.serviceChargePercent) / 100) : 0;
  const packaging = i.kind === "takeaway" && i.subtotalPaise > 0 ? i.packagingPaise : 0;
  const taxable = i.subtotalPaise - discount + service + packaging;
  const tax = Math.round((taxable * i.taxPercent) / 100);
  const raw = taxable + tax;
  const total = Math.round(raw / 100) * 100;
  return { subtotalPaise: i.subtotalPaise, discountPaise: discount, serviceChargePaise: service, packagingPaise: packaging, taxPaise: tax, roundOffPaise: total - raw, totalPaise: total };
}

/** Intra-state GST: half CGST, half SGST (the odd paisa goes to SGST). */
export const splitGst = (taxPaise: number) => ({ cgstPaise: Math.floor(taxPaise / 2), sgstPaise: taxPaise - Math.floor(taxPaise / 2) });

export interface BillHeader {
  id: string; invoiceNo: number; kind: BillKind; status: BillStatus; tableId: string | null; tableLabel: string | null;
  customerName: string | null; customerPhone: string | null; discountReason: string | null; serviceChargeOn: boolean;
  openedAt: string; settledAt: string | null; voidReason: string | null;
}

/** A bill from its header, amounts (live or frozen), rounds and payments. */
export function makeBill(h: BillHeader, a: BillAmounts, orders: Order[], payments: BillPayment[]): Bill {
  const rounds = orders.filter((o) => o.status !== "cancelled").sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const paidPaise = payments.reduce((s, p) => s + p.amountPaise, 0);
  return {
    ...h, ...a, ...splitGst(a.taxPaise),
    orders: rounds, lines: mergeLines(rounds), payments,
    paidPaise, duePaise: Math.max(0, a.totalPaise - paidPaise),
  };
}

/** Invoice numbers print as 000042. */
export const formatInvoiceNo = (n: number) => String(n).padStart(6, "0");

export const isValidGstin = (s: string) => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s);
export const isValidFssai = (s: string) => /^[0-9]{14}$/.test(s);

export const BOARD_STAGES: OrderStatus[] = ["new", "preparing", "ready", "served"];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  new: "New",
  preparing: "Preparing",
  ready: "Ready",
  served: "Served",
  cancelled: "Cancelled",
};

export const NEXT_STATUS: Partial<Record<OrderStatus, { to: OrderStatus; action: string }>> = {
  new: { to: "preparing", action: "Start cooking" },
  preparing: { to: "ready", action: "Mark ready" },
  ready: { to: "served", action: "Mark served" },
};

export function canMoveTo(from: OrderStatus, to: OrderStatus): boolean {
  if (to === "cancelled") return from !== "served";
  return NEXT_STATUS[from]?.to === to;
}

export function formatINR(paise: number): string {
  const rupees = paise / 100;
  return "₹" + rupees.toLocaleString("en-IN", { minimumFractionDigits: rupees % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

export function rupeesToPaise(input: string): number | null {
  const n = Number(input.replace(/[₹,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return null;
  return Math.round(n * 100);
}

/** Start of today in India time, as an ISO string. */
export function startOfTodayIST(now = new Date()): string {
  const offset = 330 * 60_000;
  const ist = new Date(now.getTime() + offset);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - offset).toISOString();
}

export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** UPI ID like name@okaxis or 9876543210@ybl. Same rule on the server and in forms. */
export function isValidUpiId(upiId: string): boolean {
  return /^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upiId);
}

/** Standard UPI deep link; opens GPay / PhonePe / Paytm with the amount filled in. */
// pa stays literal ("@" unencoded, already checked by isValidUpiId); pn/tn use %20, never "+",
// because some UPI apps show "+" as-is or reject an encoded "@".
export function upiLink(upiId: string, payeeName: string, paise: number, note: string): string {
  const enc = encodeURIComponent;
  return `upi://pay?pa=${upiId}&pn=${enc(payeeName)}&am=${(paise / 100).toFixed(2)}&cu=INR&tn=${enc(note)}`;
}

// ---------- login identifiers (same rules in forms and on the server) ----------
export const PASSWORD_MIN = 8;

/** Indian mobile → "+91XXXXXXXXXX", or null. Accepts spaces/dashes, a leading 0, 91 or +91. */
export function normalizeIndianPhone(raw: string): string | null {
  const digits = raw.trim().replace(/[\s\-()]/g, "");
  const m = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(digits);
  return m ? `+91${m[1]}` : null;
}

/** 3–30 of a–z 0–9 _ . with at least one letter (so a username never looks like a phone number). */
export function isValidUsername(username: string): boolean {
  return /^[a-z0-9_.]{3,30}$/.test(username) && /[a-z]/.test(username);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export type LoginIdentifier =
  | { kind: "email"; value: string }
  | { kind: "phone"; value: string }
  | { kind: "username"; value: string };

/** What the "Email, phone or username" field holds, normalised; null if it can't be any of them. */
export function detectIdentifier(raw: string): LoginIdentifier | null {
  const s = raw.trim().toLowerCase();
  if (s.includes("@")) return isValidEmail(s) ? { kind: "email", value: s } : null;
  const phone = normalizeIndianPhone(s);
  if (phone) return { kind: "phone", value: phone };
  return isValidUsername(s) ? { kind: "username", value: s } : null;
}

export const isValidPin = (pin: string): boolean => /^\d{4,6}$/.test(pin);

export const isValidEmailCode = (code: string): boolean => /^\d{6}$/.test(code);
/** Wait this long between "Resend code" taps. The server enforces it (and 5 per hour). */
export const RESEND_CODE_SECONDS = 60;

/** Shared devices lock back to "Who's working?" after this long without a tap. */
export const STAFF_IDLE_LOCK_MS = 10 * 60_000;
