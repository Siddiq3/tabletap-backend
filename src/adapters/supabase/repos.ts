import type { SupabaseClient, PostgrestError } from "@supabase/supabase-js";
import type { Repos } from "../../ports";
import { DomainError, ERROR_MESSAGES, makeBill, startOfTodayIST, type Bill } from "../../contract";
import { BILL_SELECT, ORDER_SELECT, STAFF_SELECT, STAFF_CALL_SELECT, frozenAmounts, liveAmounts, toBillHeader, toPayment, toStaffCall, toCategory, toItem, toOrder, toProfile, toRestaurant, toStaff, toTable, type Row } from "./mappers";

function fail(error: PostgrestError): never {
  const code = Object.keys(ERROR_MESSAGES).find((c) => error.message.includes(c));
  if (code) throw new DomainError(code, ERROR_MESSAGES[code]);
  if (error.code === "23505") {
    for (const [field, code] of [["slug", "SLUG_TAKEN"], ["username", "USERNAME_TAKEN"], ["email", "EMAIL_TAKEN"], ["phone", "PHONE_TAKEN"]]) {
      if (error.message.includes(field)) throw new DomainError(code, ERROR_MESSAGES[code]);
    }
  }
  throw new Error(error.message);
}

const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

function ok<T>(res: { data: T | null; error: PostgrestError | null }): T {
  if (res.error) fail(res.error);
  return res.data as T;
}

export function supabaseRepos(db: SupabaseClient): Repos {
  /** Bills with their rounds and payments; open ones get live amounts from bill_amounts. */
  async function loadBills(heads: Row[]): Promise<Bill[]> {
    if (heads.length === 0) return [];
    const ids = heads.map((h) => h.id);
    const openIds = heads.filter((h) => h.status === "open").map((h) => h.id);
    const [orders, payments, amounts] = await Promise.all([
      db.from("orders").select(ORDER_SELECT).in("bill_id", ids).order("created_at"),
      db.from("bill_payments").select("id, bill_id, method, amount_paise, created_at").in("bill_id", ids).order("created_at"),
      openIds.length ? db.from("bill_amounts").select("*").in("bill_id", openIds) : Promise.resolve({ data: [], error: null }),
    ]);
    const orderRows = ok(orders) as Row[];
    const payRows = ok(payments) as Row[];
    const live = new Map((ok(amounts) as Row[]).map((a) => [a.bill_id, liveAmounts(a)]));
    return heads.map((h) => makeBill(
      toBillHeader(h),
      h.status === "open" ? live.get(h.id)! : frozenAmounts(h),
      orderRows.filter((o) => o.bill_id === h.id).map(toOrder),
      payRows.filter((p) => p.bill_id === h.id).map(toPayment),
    ));
  }

  return {
    bills: {
      async listOpen(restaurantId) {
        return loadBills(ok(await db.from("bills").select(BILL_SELECT).eq("restaurant_id", restaurantId).eq("status", "open").order("opened_at").limit(300)) as Row[]);
      },
      async get(restaurantId, billId) {
        if (!isUuid(billId)) return null;
        const row = ok(await db.from("bills").select(BILL_SELECT).eq("restaurant_id", restaurantId).eq("id", billId).maybeSingle());
        return row ? (await loadBills([row as Row]))[0] : null;
      },
      async openBillForOrder(restaurantId, orderId) {
        if (!isUuid(orderId)) return null;
        const o = ok(await db.from("orders").select("bill_id").eq("restaurant_id", restaurantId).eq("id", orderId).maybeSingle()) as Row | null;
        if (!o?.bill_id) return null;
        const row = ok(await db.from("bills").select(BILL_SELECT).eq("id", o.bill_id).eq("status", "open").maybeSingle());
        return row ? (await loadBills([row as Row]))[0] : null;
      },
      async pay(restaurantId, billId, p, staffId) {
        ok(await db.rpc("add_bill_payment", {
          p_restaurant_id: restaurantId, p_bill_id: billId, p_method: p.method,
          p_amount_paise: p.amountPaise, p_expected_total: p.expectedTotalPaise, p_staff_id: staffId,
        }));
      },
      async update(restaurantId, billId, patch) {
        const row: Row = {};
        if (patch.discountPaise !== undefined) row.discount_paise = patch.discountPaise;
        if (patch.discountReason !== undefined) row.discount_reason = patch.discountReason;
        if (patch.serviceChargeOn !== undefined) row.service_charge_on = patch.serviceChargeOn;
        const done = ok(await db.from("bills").update(row).eq("restaurant_id", restaurantId).eq("id", billId).eq("status", "open").select("id").maybeSingle());
        return !!done;
      },
      async move(restaurantId, billId, tableId) {
        ok(await db.rpc("move_bill", { p_restaurant_id: restaurantId, p_bill_id: billId, p_to_table_id: tableId }));
      },
      async merge(restaurantId, fromBillId, intoBillId, staffId) {
        ok(await db.rpc("merge_bills", { p_restaurant_id: restaurantId, p_from: fromBillId, p_into: intoBillId, p_staff_id: staffId }));
      },
      async void(restaurantId, billId, reason, staffId) {
        ok(await db.rpc("void_bill", { p_restaurant_id: restaurantId, p_bill_id: billId, p_reason: reason, p_staff_id: staffId }));
      },
      async salesReport(restaurantId, fromIso, toIso) {
        return ok(await db.rpc("sales_report", { p_restaurant_id: restaurantId, p_from: fromIso, p_to: toIso }));
      },
    },
    staffCalls: {
      async request(restaurantId, tableId) {
        const id = ok(await db.rpc("request_staff_call", { p_restaurant_id: restaurantId, p_table_id: tableId })) as string;
        return toStaffCall(ok(await db.from("staff_calls").select(STAFF_CALL_SELECT).eq("restaurant_id", restaurantId).eq("id", id).single()));
      },
      async listPending(restaurantId) {
        const rows = ok(await db.from("staff_calls").select(STAFF_CALL_SELECT).eq("restaurant_id", restaurantId).is("resolved_at", null).order("created_at")) as Row[];
        return rows.map(toStaffCall);
      },
      async resolve(restaurantId, callId, staffId) {
        const row = ok(await db.from("staff_calls").update({ resolved_at: new Date().toISOString(), resolved_by_staff_id: staffId }).eq("restaurant_id", restaurantId).eq("id", callId).is("resolved_at", null).select("id").maybeSingle());
        return !!row;
      },
    },
    restaurants: {
      async getBySlug(slug) {
        const row = ok(await db.from("restaurants").select("*").eq("slug", slug).maybeSingle());
        return row ? toRestaurant(row) : null;
      },

      async getMembership(userId) {
        const row = ok(
          await db
            .from("restaurant_members")
            .select("role, restaurants(*)")
            .eq("user_id", userId)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle(),
        ) as Row | null;
        if (!row?.restaurants) return null;
        return { role: row.role, restaurant: toRestaurant(row.restaurants) };
      },

      async slugTaken(slug) {
        const row = ok(await db.from("restaurants").select("id").eq("slug", slug).maybeSingle());
        return !!row;
      },

      async create(input, ownerUserId) {
        return ok(
          await db.rpc("create_restaurant", {
            p_owner_id: ownerUserId,
            p_name: input.name,
            p_slug: input.slug,
            p_upi_id: input.upiId ?? "",
            p_table_count: input.tableCount,
          }),
        ) as string;
      },

      async update(restaurantId, patch) {
        const row: Row = {};
        if (patch.name !== undefined) row.name = patch.name;
        if (patch.address !== undefined) row.address = patch.address;
        if (patch.upiId !== undefined) row.upi_id = patch.upiId;
        if (patch.taxPercent !== undefined) row.tax_percent = patch.taxPercent;
        if (patch.gstin !== undefined) row.gstin = patch.gstin;
        if (patch.fssai !== undefined) row.fssai = patch.fssai;
        if (patch.serviceChargePercent !== undefined) row.service_charge_percent = patch.serviceChargePercent;
        if (patch.packagingPaise !== undefined) row.packaging_paise = patch.packagingPaise;
        ok(await db.from("restaurants").update(row).eq("id", restaurantId));
      },

      async listTables(restaurantId) {
        const rows = ok(await db.from("dining_tables").select("*").eq("restaurant_id", restaurantId)) as Row[];
        // natural sort: T2 before T10
        return rows.map(toTable).sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
      },

      async getTable(restaurantId, tableId) {
        if (!/^[0-9a-f-]{36}$/i.test(tableId)) return null;
        const row = ok(
          await db.from("dining_tables").select("*").eq("restaurant_id", restaurantId).eq("id", tableId).maybeSingle(),
        );
        return row ? toTable(row) : null;
      },

      async addTables(restaurantId, labels) {
        ok(await db.from("dining_tables").insert(labels.map((label) => ({ restaurant_id: restaurantId, label }))));
      },
    },

    menu: {
      async list(restaurantId, opts) {
        const cats = ok(
          await db.from("menu_categories").select("*").eq("restaurant_id", restaurantId).order("sort_order").order("created_at"),
        ) as Row[];
        let q = db.from("menu_items").select("*").eq("restaurant_id", restaurantId);
        if (opts?.availableOnly) q = q.eq("is_available", true);
        const items = ok(await q.order("sort_order").order("created_at")) as Row[];
        return { categories: cats.map(toCategory), items: items.map(toItem) };
      },

      async addCategory(restaurantId, name) {
        const row = ok(
          await db.from("menu_categories").insert({ restaurant_id: restaurantId, name, sort_order: Date.now() % 1e9 }).select().single(),
        ) as Row;
        return toCategory(row);
      },

      async addItem(restaurantId, item) {
        const row = ok(
          await db
            .from("menu_items")
            .insert({
              restaurant_id: restaurantId,
              category_id: item.categoryId,
              name: item.name,
              description: item.description,
              price_paise: item.pricePaise,
              is_veg: item.isVeg,
            })
            .select()
            .single(),
        ) as Row;
        return toItem(row);
      },

      async updateItem(restaurantId, itemId, patch) {
        const row: Row = {};
        if (patch.categoryId !== undefined) row.category_id = patch.categoryId;
        if (patch.name !== undefined) row.name = patch.name;
        if (patch.description !== undefined) row.description = patch.description;
        if (patch.pricePaise !== undefined) row.price_paise = patch.pricePaise;
        if (patch.isVeg !== undefined) row.is_veg = patch.isVeg;
        if (patch.isAvailable !== undefined) row.is_available = patch.isAvailable;
        ok(await db.from("menu_items").update(row).eq("restaurant_id", restaurantId).eq("id", itemId));
      },

      async deleteItem(restaurantId, itemId) {
        ok(await db.from("menu_items").delete().eq("restaurant_id", restaurantId).eq("id", itemId));
      },
    },

    orders: {
      async place(input) {
        const rows = ok(
          await db.rpc("add_order", {
            p_restaurant_id: input.restaurantId,
            p_table_id: input.tableId ?? null,
            p_bill_id: input.billId ?? null,
            p_items: input.items.map((i) => ({ menu_item_id: i.menuItemId, qty: i.qty })),
            p_note: input.note ?? "",
            p_source: input.source,
            p_staff_id: input.staffId,
            p_takeaway: !!input.takeaway,
            p_customer_name: input.takeaway?.customerName ?? null,
            p_customer_phone: input.takeaway?.customerPhone ?? null,
          }),
        ) as Row[];
        const r = rows[0];
        return { orderId: r.out_order_id, orderNo: r.out_order_no, totalPaise: r.out_total_paise, billId: r.out_bill_id };
      },

      async get(restaurantId, orderId) {
        if (!/^[0-9a-f-]{36}$/i.test(orderId)) return null;
        const row = ok(
          await db.from("orders").select(ORDER_SELECT).eq("restaurant_id", restaurantId).eq("id", orderId).maybeSingle(),
        );
        return row ? toOrder(row as Row) : null;
      },

      async listBoard(restaurantId) {
        const since = startOfTodayIST();
        const rows = ok(
          await db
            .from("orders")
            .select(ORDER_SELECT)
            .eq("restaurant_id", restaurantId)
            .or(`status.in.(new,preparing,ready),created_at.gte.${since}`)
            .order("created_at", { ascending: false })
            .limit(300),
        ) as Row[];
        return rows.map(toOrder);
      },

      async setStatus(restaurantId, orderId, status, staffId) {
        ok(
          await db
            .from("orders")
            .update({ status, status_changed_by_staff_id: staffId })
            .eq("restaurant_id", restaurantId)
            .eq("id", orderId),
        );
      },

      async markPaid(restaurantId, orderId, method, staffId) {
        ok(await db.rpc("mark_order_paid", { p_restaurant_id: restaurantId, p_order_id: orderId, p_method: method, p_staff_id: staffId }));
      },

      async cancelItem(restaurantId, orderItemId, qty, reason, staffId) {
        ok(await db.rpc("cancel_order_item", { p_restaurant_id: restaurantId, p_order_item_id: orderItemId, p_qty: qty, p_reason: reason, p_staff_id: staffId }));
      },
    },

    profiles: {
      async find(id) {
        const row = ok(await db.from("user_profiles").select("*").eq(id.kind, id.value).maybeSingle()) as Row | null;
        return row ? { userId: row.user_id, ...toProfile(row) } : null;
      },

      async get(userId) {
        const row = ok(await db.from("user_profiles").select("*").eq("user_id", userId).maybeSingle());
        return row ? toProfile(row) : null;
      },

      async create(userId, p) {
        ok(
          await db.from("user_profiles").insert({
            user_id: userId, full_name: p.fullName, username: p.username, email: p.email, phone: p.phone,
          }),
        );
      },

      async markEmailVerified(userId) {
        ok(await db.from("user_profiles").update({ email_verified_at: new Date().toISOString() }).eq("user_id", userId));
      },
    },

    emailCodes: {
      async create(userId, codeHash, expiresAt) {
        const dayAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
        ok(await db.from("email_verification_codes").delete().eq("user_id", userId).lt("created_at", dayAgo));
        ok(await db.from("email_verification_codes").insert({ user_id: userId, code_hash: codeHash, expires_at: expiresAt }));
      },

      async sentSince(userId, sinceIso) {
        const rows = ok(
          await db
            .from("email_verification_codes")
            .select("created_at")
            .eq("user_id", userId)
            .gte("created_at", sinceIso)
            .order("created_at", { ascending: false }),
        ) as Row[];
        return rows.map((r) => r.created_at);
      },

      async claimAttempt(userId) {
        const rows = ok(await db.rpc("claim_verification_attempt", { p_user_id: userId })) as Row[];
        const r = rows[0];
        return r ? { codeHash: r.out_code_hash, attemptsLeft: r.out_attempts_left } : null;
      },

      async deleteAll(userId) {
        ok(await db.from("email_verification_codes").delete().eq("user_id", userId));
      },
    },

    staff: {
      async list(restaurantId) {
        const rows = ok(
          await db.from("staff_members").select(STAFF_SELECT).eq("restaurant_id", restaurantId).order("name"),
        ) as Row[];
        return rows.map(toStaff);
      },

      async get(restaurantId, staffId) {
        if (!isUuid(staffId)) return null;
        const row = ok(
          await db.from("staff_members").select(STAFF_SELECT).eq("restaurant_id", restaurantId).eq("id", staffId).maybeSingle(),
        );
        return row ? toStaff(row as Row) : null;
      },

      async create(restaurantId, input) {
        const row = ok(
          await db
            .from("staff_members")
            .insert({ restaurant_id: restaurantId, name: input.name, role: input.role, pin_hash: input.pinHash })
            .select(STAFF_SELECT)
            .single(),
        ) as Row;
        return toStaff(row);
      },

      async update(restaurantId, staffId, patch) {
        const row: Row = {};
        if (patch.name !== undefined) row.name = patch.name;
        if (patch.role !== undefined) row.role = patch.role;
        if (patch.isActive !== undefined) row.is_active = patch.isActive;
        const updated = ok(
          await db.from("staff_members").update(row).eq("restaurant_id", restaurantId).eq("id", staffId).select(STAFF_SELECT).single(),
        ) as Row;
        return toStaff(updated);
      },

      async setPinHash(restaurantId, staffId, pinHash) {
        ok(
          await db
            .from("staff_members")
            .update({ pin_hash: pinHash, failed_pin_attempts: 0, locked_until: null })
            .eq("restaurant_id", restaurantId)
            .eq("id", staffId),
        );
      },

      async claimPinAttempt(staffId) {
        if (!isUuid(staffId)) return null;
        const rows = ok(await db.rpc("claim_pin_attempt", { p_staff_id: staffId })) as Row[];
        const r = rows[0];
        return r ? { pinHash: r.out_pin_hash, restaurantId: r.out_restaurant_id } : null;
      },

      async pinSucceeded(staffId) {
        ok(await db.from("staff_members").update({ failed_pin_attempts: 0, locked_until: null }).eq("id", staffId));
      },

      async createSession(staffId, tokenHash, expiresAt) {
        ok(await db.from("staff_sessions").insert({ staff_id: staffId, token_hash: tokenHash, expires_at: expiresAt }));
      },

      async findSession(tokenHash) {
        const row = ok(
          await db
            .from("staff_sessions")
            .select(`staff_members!inner(${STAFF_SELECT}, restaurant_id)`)
            .eq("token_hash", tokenHash)
            .is("revoked_at", null)
            .gt("expires_at", new Date().toISOString())
            .eq("staff_members.is_active", true)
            .maybeSingle(),
        ) as Row | null;
        const m = row?.staff_members;
        return m ? { staff: toStaff(m), restaurantId: m.restaurant_id } : null;
      },

      async revokeSessions(staffId) {
        ok(
          await db.from("staff_sessions").update({ revoked_at: new Date().toISOString() }).eq("staff_id", staffId).is("revoked_at", null),
        );
      },
    },
  };
}
