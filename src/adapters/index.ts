// Backend switch. To move to AWS: add src/adapters/aws/ (pg client + Cognito), add a case, set DATA_BACKEND=aws.
import type { AuthVerifier, Repos } from "../ports";
import { supabaseRepos } from "./supabase/repos";
import { supabaseAuthVerifier } from "./supabase/auth";
import { supabase } from "./supabase/client";

const backend = () => process.env.DATA_BACKEND ?? "supabase";

let repos: Repos | null = null;

export function getRepos(): Repos {
  if (repos) return repos;
  switch (backend()) {
    case "supabase":
      return (repos = supabaseRepos(supabase()));
    default:
      throw new Error(`Unknown DATA_BACKEND "${backend()}"`);
  }
}

export function getAuthVerifier(): AuthVerifier {
  switch (backend()) {
    case "supabase":
      return supabaseAuthVerifier;
    default:
      throw new Error(`Unknown DATA_BACKEND "${backend()}"`);
  }
}
