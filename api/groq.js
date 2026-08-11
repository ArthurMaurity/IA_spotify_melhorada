// Vercel Serverless Function — POST /api/groq
// Keeps the Groq API key server-side; the browser never sees it.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama3-8b-8192';

const SYSTEM_PROMPT = [
  'You are an expert AI DJ curating a Spotify queue.',
  'Suggest between 2 and 4 songs that should play next, staying coherent with the current track\'s genre, tempo and energy unless the listener\'s custom instruction says otherwise.',
  'Respond with RAW JSON only (no markdown fences, no prose), exactly in this shape:',
  '{"tracks":[{"artist":"...","title":"...","why":"one short sentence"}]}',
].join(' ');

function buildUserPrompt({ track, artist, mode, customPrompt }) {
  const parts = [];
  if (track || artist) {
    parts.push(`Current track: "${track || 'unknown'}" by ${artist || 'unknown artist'}.`);
  }
  if (mode) {
    parts.push(`Selected mode: ${mode}.`);
  }
  if (customPrompt) {
    parts.push(`Listener's instruction: "${customPrompt}"`);
  }
  parts.push('Suggest exactly 2 to 4 songs that fit.');
  return parts.join(' ');
}

function extractJson(text) {
  const cleaned = String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server' });
  }

  const { track, artist, mode, customPrompt } = req.body || {};

  try {
    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.8,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt({ track, artist, mode, customPrompt }) },
        ],
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return res.status(groqRes.status).json({ error: `Groq request failed: ${errText}` });
    }

    const data = await groqRes.json();
    const rawText = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJson(rawText);

    if (!parsed || !Array.isArray(parsed.tracks) || parsed.tracks.length === 0) {
      return res.status(502).json({ error: 'Groq response could not be parsed as track JSON', raw: rawText });
    }

    const tracks = parsed.tracks
      .filter((t) => t && t.title && t.artist)
      .slice(0, 4)
      .map((t) => ({
        title: String(t.title).trim(),
        artist: String(t.artist).trim(),
        why: t.why ? String(t.why).trim() : '',
      }));

    return res.status(200).json({ tracks });
  } catch (err) {
    return res.status(500).json({ error: `Unexpected error: ${err.message}` });
  }
};
