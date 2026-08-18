// Vercel Serverless Function — GET /api/health
//
// A cheap "is the backend sane right now" probe. Deliberately does NOT call
// Groq: hitting a health endpoint must never itself consume the free-tier
// quota it is meant to help protect. It only reports which env vars are
// present and what a warm instance currently holds in its model cache.
//
// Note the model cache is per-instance, so two consecutive calls can hit
// different instances and report different cache states (one warm, one cold
// with an empty list). That is expected on serverless, not a fault — a
// `models: []` response means "this instance hasn't served a request yet",
// not "no models available".

const { enforceRateLimit } = require('./_ratelimit');
const groq = require('./groq');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (enforceRateLimit(req, res, 'health', 30)) return;

  const cache = groq.peekModelCache ? groq.peekModelCache() : { models: [], cachedAt: null, ageMs: null, ttlMs: null };

  // Presence only — never the values themselves. This endpoint is public.
  const configured = {
    groq: !!process.env.GROQ_API_KEY,
    youtube: !!(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET),
    apple: !!(process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY),
  };

  // Groq is the only hard requirement: without it there are no suggestions at
  // all, which is the entire product. The other two are optional providers.
  const status = configured.groq ? 'ok' : 'misconfigured';

  // Health data is a point-in-time snapshot of one instance — caching it at a
  // CDN edge would make it actively misleading.
  res.setHeader('Cache-Control', 'no-store');

  return res.status(status === 'ok' ? 200 : 503).json({
    status,
    configured,
    modelCache: {
      count: cache.models.length,
      models: cache.models,
      ageMs: cache.ageMs,
      ttlMs: cache.ttlMs,
      // null when this instance is cold and has never listed the catalog.
      stale: cache.ageMs != null && cache.ttlMs != null ? cache.ageMs > cache.ttlMs : null,
    },
  });
};
