import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { AuthProvider } from "../../ports";
import { DomainError, ERROR_MESSAGES } from "../../contract";
import { env } from "../../env";
import { supabase } from "./client";

/**
 * A fresh client per sign-in. Never sign in on the shared service-role client: it would keep the
 * user's session and send their token on every later database call instead of the service key.
 */
const throwaway = () =>
  createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

/** Login address for accounts without an email. Never shown, never mailed (.invalid can't receive mail). */
const internalEmail = () => `u_${randomUUID()}@users.tabletap.invalid`;

export const supabaseAuth: AuthProvider = {
  async verify(token) {
    const { data, error } = await supabase().auth.getUser(token);
    if (error) return null;
    return data.user?.id ?? null;
  },

  async createUser({ email, password }) {
    const { data, error } = await supabase().auth.admin.createUser({
      email: email ?? internalEmail(),
      password,
      email_confirm: true, // no confirmation email
    });
    if (error) {
      if (error.code === "email_exists" || /already (been )?registered/i.test(error.message)) {
        throw new DomainError("EMAIL_TAKEN", ERROR_MESSAGES.EMAIL_TAKEN);
      }
      throw new Error(`createUser: ${error.message}`);
    }
    return data.user.id;
  },

  async deleteUser(userId) {
    const { error } = await supabase().auth.admin.deleteUser(userId);
    if (error) console.error("deleteUser", userId, error.message);
  },

  async signInWithPassword(who, password) {
    let email: string;
    if ("email" in who) {
      email = who.email;
    } else {
      const { data, error } = await supabase().auth.admin.getUserById(who.userId);
      if (error || !data.user?.email) return null;
      email = data.user.email;
    }
    const { data, error } = await throwaway().auth.signInWithPassword({ email, password });
    if (error || !data.session) return null;
    return { accessToken: data.session.access_token, refreshToken: data.session.refresh_token };
  },

  async sendPasswordReset(email) {
    const { error } = await throwaway().auth.resetPasswordForEmail(email, { redirectTo: env("PASSWORD_RESET_URL") });
    if (error) console.error("resetPasswordForEmail", error.message);
  },
};
