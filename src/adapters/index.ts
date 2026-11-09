// Backend switch. To move to AWS: add src/adapters/aws/ (pg client + Cognito), add a case, set DATA_BACKEND=aws.
import type { AuthProvider, Mailer, Repos } from "../ports";
import { env } from "../env";
import { consoleMailer, resendMailer } from "./mail";
import { supabaseRepos } from "./supabase/repos";
import { supabaseAuth } from "./supabase/auth";
import { supabase } from "./supabase/client";

const backend = () => process.env.DATA_BACKEND ?? "supabase";

let repos: Repos | null = null;
let auth: AuthProvider | null = null;
let mail: Mailer | null = null;

export function getRepos(): Repos {
  if (repos) return repos;
  switch (backend()) {
    case "supabase":
      return (repos = supabaseRepos(supabase()));
    default:
      throw new Error(`Unknown DATA_BACKEND "${backend()}"`);
  }
}

export function getAuth(): AuthProvider {
  if (auth) return auth;
  switch (backend()) {
    case "supabase":
      return (auth = supabaseAuth);
    default:
      throw new Error(`Unknown DATA_BACKEND "${backend()}"`);
  }
}

/** MAILER is required (no default), so a server never silently logs codes instead of emailing them. */
export function getMailer(): Mailer {
  if (mail) return mail;
  const kind = env("MAILER");
  switch (kind) {
    case "resend":
      env("RESEND_API_KEY");
      env("MAIL_FROM");
      return (mail = resendMailer);
    case "console":
      return (mail = consoleMailer);
    default:
      throw new Error(`Unknown MAILER "${kind}". Use resend or console.`);
  }
}

/** Tests only: run the API against in-memory fakes. */
export function setBackendForTests(r: Repos, a: AuthProvider, m?: Mailer) {
  repos = r;
  auth = a;
  if (m) mail = m;
}
