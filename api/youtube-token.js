// Vercel Serverless Function — POST /api/youtube-token
// Google's OAuth token endpoint requires a client_secret at exchange time
// even for a PKCE request from a "Web application" client type — unlike
// Spotify, which is PKCE-only with no secret at all. (Confirmed against
// Google's own docs before building this — it's a real deviation from plain
// OAuth 2.0 + PKCE that's easy to assume away.) This endpoint holds
// YOUTUBE_CLIENT_SECRET server-side and proxies the authorization_code and
// refresh_token grants, the same way api/groq.js keeps GROQ_API_KEY off the
// client. The client-side code (index.html) always talks to this endpoint
// with a plain JSON body — never to Google's token endpoint directly.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET not configured on the server' });
  }

  const { grant_type, code, code_verifier, redirect_uri, refresh_token } = req.body || {};
  // client_id/client_secret always come from server env vars, never trusted
  // from the request body, even though the client also sends a client_id
  // (the public one baked into index.html) for shape-consistency with the
  // generic PKCE flow used by the other providers.
  const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });

  if (grant_type === 'authorization_code') {
    if (!code || !redirect_uri) {
      return res.status(400).json({ error: 'Missing code/redirect_uri for authorization_code grant' });
    }
    params.set('grant_type', 'authorization_code');
    params.set('code', code);
    params.set('redirect_uri', redirect_uri);
    if (code_verifier) params.set('code_verifier', code_verifier);
  } else if (grant_type === 'refresh_token') {
    if (!refresh_token) {
      return res.status(400).json({ error: 'Missing refresh_token for refresh_token grant' });
    }
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refresh_token);
  } else {
    return res.status(400).json({ error: 'grant_type must be authorization_code or refresh_token' });
  }

  try {
    const googleRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const data = await googleRes.json();
    if (!googleRes.ok) {
      return res.status(googleRes.status).json({ error: data.error_description || data.error || 'Google token exchange failed' });
    }
    // Google's refresh_token grant response omits refresh_token (it's only
    // issued on the initial authorization_code exchange) — pass through
    // whatever it gives us as-is; the client already tolerates a response
    // with no refresh_token field (see refreshAccessToken in index.html).
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected error' });
  }
};
