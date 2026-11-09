// Backend switch. To move to AWS: add src/adapters/aws/ (pg client + Cognito), add a case, set DATA_BACKEND=aws.
import type { AuthProvider, Repos } from "../ports";
import { supabaseRepos } from "./supabase/repos";
import { supabaseAuth } from "./supabase/auth";
import { supabase } from "./supabase/client";

const backend = () => process.env.DATA_BACKEND ?? "supabase";

let repos: Repos | null = null;
let auth: AuthProvider | null = null;

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

/** Tests only: run the API against in-memory fakes. */
export function setBackendForTests(r: Repos, a: AuthProvider) {
  repos = r;
  auth = a;
}
