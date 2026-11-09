import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

/**
 * Simple per-IP limiter kept in memory. Fine for one server.
 * When running several servers or on Lambda, swap for a shared store (Redis/Upstash, DynamoDB).
 */
export function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return createMiddleware(async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? c.req.header("x-real-ip") ?? "unknown";
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || entry.resetAt < now) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
    } else if (++entry.count > max) {
      throw new HTTPException(429, { message: "Too many orders from this phone. Wait a minute and try again." });
    }
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
    await next();
  });
}
