// Database rows (snake_case) → domain objects (camelCase). The only place that knows column names.
import type { DiningTable, MenuCategory, MenuItem, Order, Restaurant, Role } from "../../contract";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export const ORDER_SELECT =
  "id, order_no, table_id, status, payment_status, payment_method, note, subtotal_paise, tax_paise, total_paise, created_at, " +
  "dining_tables(label), order_items(name, is_veg, unit_price_paise, qty)";

export const toRestaurant = (r: Row): Restaurant => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  address: r.address ?? null,
  upiId: r.upi_id ?? null,
  taxPercent: Number(r.tax_percent),
  plan: r.plan,
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
  lines: (r.order_items ?? []).map((l: Row) => ({
    name: l.name,
    isVeg: l.is_veg,
    unitPricePaise: l.unit_price_paise,
    qty: l.qty,
  })),
});
