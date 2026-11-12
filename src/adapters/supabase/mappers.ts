// Database rows (snake_case) → domain objects (camelCase). The only place that knows column names.
import type { BillAmounts, BillHeader, BillPayment, DiningTable, MenuCategory, MenuItem, Order, Restaurant, Role, StaffCall, StaffMember, UserProfile } from "../../contract";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export const ORDER_SELECT =
  "id, order_no, table_id, bill_id, source, status, payment_status, payment_method, note, subtotal_paise, tax_paise, total_paise, created_at, " +
  "dining_tables(label), order_items(id, name, is_veg, unit_price_paise, qty), " +
  "paid_by:staff_members!orders_paid_by_staff_id_fkey(name), placed_by:staff_members!orders_placed_by_staff_id_fkey(name)";

export const BILL_SELECT =
  "id, invoice_no, kind, status, table_id, customer_name, customer_phone, discount_paise, discount_reason, service_charge_on, " +
  "subtotal_paise, service_charge_paise, packaging_paise, tax_paise, round_off_paise, total_paise, opened_at, settled_at, void_reason, dining_tables(label)";

export const toBillHeader = (r: Row): BillHeader => ({
  id: r.id,
  invoiceNo: r.invoice_no,
  kind: r.kind,
  status: r.status,
  tableId: r.table_id ?? null,
  tableLabel: r.dining_tables?.label ?? null,
  customerName: r.customer_name ?? null,
  customerPhone: r.customer_phone ?? null,
  discountReason: r.discount_reason ?? null,
  serviceChargeOn: r.service_charge_on,
  openedAt: r.opened_at,
  settledAt: r.settled_at ?? null,
  voidReason: r.void_reason ?? null,
});

/** Closed bills keep the amounts frozen at settlement. */
export const frozenAmounts = (r: Row): BillAmounts => ({
  subtotalPaise: r.subtotal_paise ?? 0,
  discountPaise: r.discount_paise ?? 0,
  serviceChargePaise: r.service_charge_paise ?? 0,
  packagingPaise: r.packaging_paise ?? 0,
  taxPaise: r.tax_paise ?? 0,
  roundOffPaise: r.round_off_paise ?? 0,
  totalPaise: r.total_paise ?? 0,
});

/** Open bills: the bill_amounts view. */
export const liveAmounts = (r: Row): BillAmounts => ({
  subtotalPaise: r.subtotal,
  discountPaise: r.discount,
  serviceChargePaise: r.service,
  packagingPaise: r.packaging,
  taxPaise: r.tax,
  roundOffPaise: r.round_off,
  totalPaise: r.total,
});

export const toPayment = (r: Row): BillPayment => ({ id: r.id, method: r.method, amountPaise: r.amount_paise, createdAt: r.created_at });

export const toRestaurant = (r: Row): Restaurant => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  address: r.address ?? null,
  upiId: r.upi_id ?? null,
  taxPercent: Number(r.tax_percent),
  plan: r.plan,
  gstin: r.gstin ?? null,
  fssai: r.fssai ?? null,
  serviceChargePercent: Number(r.service_charge_percent ?? 0),
  packagingPaise: r.packaging_paise ?? 0,
});

export const toRole = (r: Row): Role => r.role;

export const toTable = (r: Row): DiningTable => ({
  id: r.id,
  label: r.label,
  seats: r.seats,
  isActive: r.is_active,
});

export const toCategory = (r: Row): MenuCategory => ({
  id: r.id,
  name: r.name,
  sortOrder: r.sort_order,
});

export const toItem = (r: Row): MenuItem => ({
  id: r.id,
  categoryId: r.category_id,
  name: r.name,
  description: r.description ?? null,
  pricePaise: r.price_paise,
  isVeg: r.is_veg,
  isAvailable: r.is_available,
  imageUrl: r.image_url ?? null,
});

export const toOrder = (r: Row): Order => ({
  id: r.id,
  orderNo: r.order_no,
  tableId: r.table_id ?? null,
  tableLabel: r.dining_tables?.label ?? null,
  status: r.status,
  paymentStatus: r.payment_status,
  paymentMethod: r.payment_method ?? null,
  note: r.note ?? null,
  subtotalPaise: r.subtotal_paise,
  taxPaise: r.tax_paise,
  totalPaise: r.total_paise,
  createdAt: r.created_at,
  paidByName: r.paid_by?.name ?? null,
  billId: r.bill_id ?? null,
  source: r.source ?? "qr",
  placedByName: r.placed_by?.name ?? null,
  lines: (r.order_items ?? []).map((l: Row) => ({
    id: l.id,
    name: l.name,
    isVeg: l.is_veg,
    unitPricePaise: l.unit_price_paise,
    qty: l.qty,
  })),
});

export const STAFF_SELECT = "id, name, role, is_active";

export const toStaff = (r: Row): StaffMember => ({
  id: r.id,
  name: r.name,
  role: r.role,
  isActive: r.is_active,
});

export const toProfile = (r: Row): UserProfile => ({
  fullName: r.full_name,
  username: r.username,
  email: r.email ?? null,
  phone: r.phone ?? null,
  emailVerified: !r.email || !!r.email_verified_at,
});

export const STAFF_CALL_SELECT = "id, table_id, created_at, resolved_at, dining_tables(label)";
export const toStaffCall = (r: Row): StaffCall => ({ id: r.id, tableId: r.table_id, tableLabel: r.dining_tables?.label ?? "Unknown table", createdAt: r.created_at, resolvedAt: r.resolved_at ?? null });
