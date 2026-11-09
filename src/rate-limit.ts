import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

/**
 * Simple limiter kept in memory. Fine for one server.
 * ponytail: per-process memory; with several servers or Lambda, swap for a shared store (Redis/Upstash, DynamoDB).
 */
export function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  /** Counts one hit for `key`; false once it's over the limit. */
  return (key: string): boolean => {
    const now = Date.now();
    const entry = hits.get(key);
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    return ++entry.count <= max;
  };
}

export const clientIp = (c: { req: { header: (n: string) => string | undefined } }): string =>
  c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? c.req.header("x-real-ip") ?? "unknown";

/** Per-IP limit as middleware. */
export function rateLimit(max: number, windowMs: number, message = "Too many orders from this phone. Wait a minute and try again.") {
  const hit = limiter(max, windowMs);
  return createMiddleware(async (c, next) => {
    if (!hit(clientIp(c))) throw new HTTPException(429, { message });
    await next();
  });
}
