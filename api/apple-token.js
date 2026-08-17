// Vercel Serverless Function — GET /api/apple-token
// Mints an Apple MusicKit "developer token" (a JWT signed with the app's
// MusicKit private key) so the browser never needs the private key itself —
// same reasoning as api/groq.js keeping GROQ_API_KEY server-side.
//
// Hand-rolled with Node's built-in `crypto` (ES256 / P-256 ECDSA) instead of
// a JWT library, to keep this repo dependency-free (package.json has zero
// runtime deps today; this shouldn't be the thing that changes that). The
// signature encoding (dsaEncoding: 'ieee-p1363', giving a raw 64-byte r||s
// pair instead of Node's default DER/ASN.1 encoding) was verified against a
// throwaway keypair before wiring this up for real — DER vs P1363 is the
// single most common way to get a hand-rolled ES256 JWT signer subtly wrong.
//
// Apple's docs cap developer token expiry at 6 months (15777000s); this
// mints one valid for 12h and re-mints on the next cold start, cached at
// module scope in between (same caching shape as api/groq.js's model list).
/*
const crypto = require('crypto');

const EXPIRY_SECONDS = 12 * 60 * 60; // 12h — comfortably under Apple's 6-month cap, cheap to re-mint
let cached = null; // { token, expiresAt }

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signDeveloperToken({ teamId, keyId, privateKeyPem }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId };
  const payload = { iss: teamId, iat: now, exp: now + EXPIRY_SECONDS };

  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));

  const signer = crypto.createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: privateKeyPem, dsaEncoding: 'ieee-p1363' });

  return signingInput + '.' + base64url(signature);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  // Vercel env vars are single-line; PEM files have real newlines. Accept
  // either the raw multi-line PEM or a \n-escaped single-line version and
  // normalize both, since which one a person pastes tends to vary by how
  // they get the value into the dashboard/CLI.
  const rawKey = process.env.APPLE_PRIVATE_KEY;
  const privateKeyPem = rawKey ? rawKey.replace(/\\n/g, '\n') : null;

  if (!teamId || !keyId || !privateKeyPem) {
    return res.status(500).json({ error: 'APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY not configured on the server' });
  }

  const now = Date.now();
  if (!cached || cached.expiresAt < now) {
    try {
      const token = signDeveloperToken({ teamId, keyId, privateKeyPem });
      cached = { token, expiresAt: now + (EXPIRY_SECONDS - 300) * 1000 }; // re-mint 5min early
    } catch (err) {
      return res.status(500).json({ error: 'Failed to sign Apple developer token: ' + err.message });
    }
  }

  return res.status(200).json({ developerToken: cached.token });
};
*/