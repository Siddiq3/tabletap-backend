import type { AuthVerifier } from "../../ports";
import { supabase } from "./client";

export const supabaseAuthVerifier: AuthVerifier = {
  async verify(token) {
    const { data, error } = await supabase().auth.getUser(token);
    if (error) return null;
    return data.user?.id ?? null;
  },
};
