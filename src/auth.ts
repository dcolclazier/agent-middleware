import type { Request, Response, NextFunction } from "express";

/**
 * Auth for /api/sessions/* and any other Claude-session control routes.
 *
 * Requires `X-Middleware-Token` header matching MIDDLEWARE_TOKEN env var,
 * OR falls back to `X-Canon-Token` matching CANON_COMMIT_TOKEN (so existing
 * LAN clients that already hold the canon token keep working without a
 * config change). Fails CLOSED: if neither env var is set, every request
 * is rejected with 503. Never silently allows.
 *
 * Previously this was a no-op pass-through on the assumption that the
 * middleware was bound to a private LAN, but the process listens on
 * 0.0.0.0:3000 and `POST /api/sessions` launches an interactive Claude Code
 * CLI child with `--permission-mode bypassPermissions` — i.e. effectively
 * remote code execution for anyone on the LAN. This can't stay open.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const middlewareToken = process.env.MIDDLEWARE_TOKEN || "";
  const canonToken = process.env.CANON_COMMIT_TOKEN || "";

  if (!middlewareToken && !canonToken) {
    res.status(503).json({
      error:
        "Middleware not configured: set MIDDLEWARE_TOKEN (or CANON_COMMIT_TOKEN as a fallback) to enable session endpoints",
    });
    return;
  }

  const providedMw = req.header("x-middleware-token") || "";
  const providedCanon = req.header("x-canon-token") || "";

  const mwOk = middlewareToken !== "" && providedMw === middlewareToken;
  const canonOk = canonToken !== "" && providedCanon === canonToken;

  if (!mwOk && !canonOk) {
    res.status(401).json({
      error:
        "Missing or invalid auth: send X-Middleware-Token or X-Canon-Token",
    });
    return;
  }

  next();
}

/**
 * Auth middleware for /api/canon/* routes.
 * Requires BOTH:
 *   - X-Canon-Token header matching CANON_COMMIT_TOKEN env var
 *   - client IP in CANON_COMMIT_ALLOWED_IPS (comma-separated)
 */
export function canonAuth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.CANON_COMMIT_TOKEN || "";
  if (!expected) {
    res.status(503).json({ error: "Canon endpoint not configured (CANON_COMMIT_TOKEN missing)" });
    return;
  }

  const provided = req.header("x-canon-token") || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Invalid or missing X-Canon-Token header" });
    return;
  }

  const allowedRaw = process.env.CANON_COMMIT_ALLOWED_IPS || "127.0.0.1";
  const allowed = new Set(
    allowedRaw.split(",").map((s) => s.trim()).filter(Boolean)
  );

  // Normalize the client IP (strip IPv6 ::ffff: prefix for IPv4-mapped addresses)
  let clientIp = req.socket.remoteAddress || "";
  if (clientIp.startsWith("::ffff:")) clientIp = clientIp.slice(7);
  if (clientIp === "::1") clientIp = "127.0.0.1";

  if (!allowed.has(clientIp)) {
    res.status(403).json({ error: `Client IP ${clientIp} not in allowlist` });
    return;
  }

  next();
}
