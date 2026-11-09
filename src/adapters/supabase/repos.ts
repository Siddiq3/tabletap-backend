import type { SupabaseClient, PostgrestError } from "@supabase/supabase-js";
import type { Repos } from "../../ports";
import { DomainError, ERROR_MESSAGES, startOfTodayIST } from "../../contract";
import { ORDER_SELECT, toCategory, toItem, toOrder, toRestaurant, toTable, type Row } from "./mappers";

function fail(error: PostgrestError): never {
  const code = Object.keys(ERROR_MESSAGES).find((c) => error.message.includes(c));
  if (code) throw new DomainError(code, ERROR_MESSAGES[code]);
  if (error.code === "23505" && error.message.includes("slug")) throw new DomainError("SLUG_TAKEN", ERROR_MESSAGES.SLUG_TAKEN);
  throw new Error(error.message);
}

function ok<T>(res: { data: T | null; error: PostgrestError | null }): T {
  if (res.error) fail(res.error);
  return res.data as T;
}

export function supabaseRepos(db: SupabaseClient): Repos {
  return {
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
          await db.rpc("place_order", {
            p_restaurant_id: input.restaurantId,
            p_table_id: input.tableId,
            p_items: input.items.map((i) => ({ menu_item_id: i.menuItemId, qty: i.qty })),
            p_note: input.note ?? "",
          }),
        ) as Row[];
        const r = rows[0];
        return { orderId: r.out_order_id, orderNo: r.out_order_no, totalPaise: r.out_total_paise };
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

      async setStatus(restaurantId, orderId, status) {
        ok(await db.from("orders").update({ status }).eq("restaurant_id", restaurantId).eq("id", orderId));
      },

      async markPaid(restaurantId, orderId, method) {
        ok(
          await db
            .from("orders")
            .update({ payment_status: "paid", payment_method: method })
            .eq("restaurant_id", restaurantId)
            .eq("id", orderId),
        );
      },
    },
  };
}
