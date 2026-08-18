// Shared best-effort rate limiter for the serverless functions.
//
// Files under api/ whose name starts with `_` are NOT routed as functions by
// Vercel, so this is a plain shared module, not an endpoint.
//
// IMPORTANT — what this does and does not protect against.
// Vercel serverless instances are per-instance and ephemeral: this Map lives
// in one warm instance's memory, so N concurrent instances each enforce their
// own independent budget, and a cold start resets the counter entirely. That
// makes this a *speed bump*, not a real global rate limit. It exists because
// GROQ_API_KEY sits behind /api/groq with no auth at all — anyone who finds
// the deployed URL can otherwise drain the whole free-tier quota in a loop.
// A single warm instance absorbing the common case (one script hammering one
// endpoint) is worth the ~20 lines; a genuinely global limit would need Vercel
// KV / Redis, which is not free and is explicitly out of scope.
//
// Groq's own 429 remains the real backstop. This just means we rarely reach it.

const WINDOW_MS = 60 * 1000; // fixed 1-minute window
const MAX_ENTRIES = 500;     // hard cap so a spray of spoofed IPs can't grow this unboundedly

const buckets = new Map();

// Vercel sits behind a proxy, so req.socket.remoteAddress is the proxy, not
// the caller. x-forwarded-for is a comma-separated chain (client, proxy1, ...);
// the leftmost entry is the original client. It IS spoofable by the caller,
// which is fine — see the module comment: this is a speed bump, and a spoofing
// caller still gets capped by MAX_ENTRIES eviction plus Groq's own 429.
function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : String(fwd || ''))
    .split(',')[0]
    .trim();
  return ip || req.socket?.remoteAddress || 'unknown';
}

// Drops every window that has already elapsed. Called on each request, so the
// Map self-cleans under normal traffic without needing a timer (serverless has
// nowhere to hang a setInterval anyway — the instance may freeze between calls).
function purgeExpired(now) {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}

// Brings the Map back under MAX_ENTRIES.
//
// Eviction order matters more than it looks. The obvious policy — plain FIFO
// on insertion order — is exactly backwards under the attack this cap exists
// to survive: a flooder spraying spoofed x-forwarded-for values inserts
// hundreds of fresh single-hit buckets, pushing the map over the cap, and the
// oldest entry evicted is the flooder's *own* real bucket, the one already at
// its limit. Their budget resets and the limiter becomes a no-op. (Caught by
// a test in test-api.js, which still guards this.)
//
// So: drop the callers who have not yet reached their limit before the ones
// who have. Under a spoofed flood every decoy sits at count 1 and is dropped;
// the record that is actually doing the flooding survives, still blocked.
function evict(now, protectedKey) {
  purgeExpired(now);
  if (buckets.size <= MAX_ENTRIES) return;

  // Pass 1: non-offenders, in insertion order (oldest harmless caller first).
  for (const [key, bucket] of buckets) {
    if (buckets.size <= MAX_ENTRIES) return;
    if (key === protectedKey) continue;
    if (bucket.count < bucket.limit) buckets.delete(key);
  }

  // Pass 2: everyone left is at or over their limit — genuinely out of room,
  // so fall back to FIFO. Reaching here means MAX_ENTRIES distinct clients are
  // simultaneously over budget, which is well past what this module pretends
  // to handle; Groq's own 429 is the backstop.
  for (const key of buckets.keys()) {
    if (buckets.size <= MAX_ENTRIES) return;
    if (key === protectedKey) continue;
    buckets.delete(key);
  }
}

/**
 * @param {object} req            Node/Vercel request
 * @param {string} route          Namespace so per-route budgets stay independent
 * @param {number} limit          Max requests per WINDOW_MS for this route
 * @returns {{ok: true, remaining: number} | {ok: false, retryAfter: number}}
 */
function rateLimit(req, route, limit) {
  const now = Date.now();
  const key = route + '|' + clientKey(req);

  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    // `limit` is stored on the bucket so eviction can tell an offender from a
    // harmless caller without the caller passing the limit in again.
    bucket = { count: 0, resetAt: now + WINDOW_MS, limit };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  bucket.limit = limit;

  if (buckets.size > MAX_ENTRIES) evict(now, key);

  if (bucket.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { ok: true, remaining: Math.max(0, limit - bucket.count) };
}

/**
 * Applies rateLimit and writes the 429 response itself when over budget.
 * Returns true when the caller should stop handling the request.
 */
function enforceRateLimit(req, res, route, limit) {
  const verdict = rateLimit(req, route, limit);
  if (verdict.ok) {
    res.setHeader('X-RateLimit-Remaining', String(verdict.remaining));
    return false;
  }
  res.setHeader('Retry-After', String(verdict.retryAfter));
  res.status(429).json({
    error: 'Too many requests — slow down.',
    retryAfter: verdict.retryAfter,
  });
  return true;
}

// _resetForTests exists purely so the test harness can get a clean Map between
// cases; nothing in the request path should ever call it.
module.exports = {
  rateLimit,
  enforceRateLimit,
  clientKey,
  WINDOW_MS,
  MAX_ENTRIES,
  _resetForTests: () => buckets.clear(),
};
