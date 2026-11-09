import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../env";

let client: SupabaseClient | null = null;

/** Server-only client with full access. The API enforces restaurant access in code (see app.ts). */
export function supabase(): SupabaseClient {
  client ??= createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
