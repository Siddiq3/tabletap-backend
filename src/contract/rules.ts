// CONTRACT FILE — identical copies live in tabletap-backend, tabletap-web and tabletap-app.
// When you change it, make the same change in the other two repos in the same week,
// and bump CONTRACT_VERSION in index.ts.

import type { OrderStatus } from "./types";

export class DomainError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export const ERROR_MESSAGES: Record<string, string> = {
  EMPTY_ORDER: "Your cart is empty. Add a dish first.",
  INVALID_TABLE: "This table QR is not active. Ask the staff for help.",
  ITEM_UNAVAILABLE: "A dish in your cart just sold out. Remove it and try again.",
  RESTAURANT_UNAVAILABLE: "This restaurant is not taking orders right now.",
  SLUG_TAKEN: "That link is already used by another restaurant. Try another.",
};

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
