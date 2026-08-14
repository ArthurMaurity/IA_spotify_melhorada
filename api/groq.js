// Vercel Serverless Function — POST /api/groq
// Keeps the Groq API key server-side; the browser never sees it.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// 70b has far deeper knowledge of specific artists/subgenres than the 8b-instant
// tier, which tended to fall back to generic mainstream picks.
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = [
  'You are an expert DJ specialized in seamless transitions, with deep knowledge of genres, subgenres, tempo (BPM) and production style across music history.',
  'GROUNDING RULE (mandatory): when the prompt gives you "Confirmed Spotify genres" for the artist, treat that as ground truth about the real artist\'s style — it always overrides your own guess if they conflict. When no confirmed genres are given, fall back to your own knowledge of that specific real artist and song.',
  'GOLDEN RULE (mandatory, unless overridden below): your suggestions must share the same concrete genre/subgenre, approximate BPM and energy level as the current track — not just a vague "similar vibe". Reject generic mainstream/pop crossover picks unless the source track itself is mainstream pop. When a measured tempo/energy/danceability is given for the current track, treat it as ground truth and match numerically (target BPM within about 15 of it) instead of guessing from genre alone.',
  'TOP PRIORITY OVERRIDE: if the listener gives an explicit instruction naming a concrete genre, subgenre or style (e.g. "trap", "reggae rock brasileiro", "bossa nova"), that request wins over the GOLDEN RULE and over matching the current track — pick real songs that genuinely belong to that named genre/scene, even if it is a hard cut from the current track\'s style. Treat regional or non-English genre names as literal, specific tags, not as something to approximate with a mainstream substitute — draw on your deep knowledge of that country/scene\'s real artists and catalog (e.g. for Brazilian genres, think of the actual Brazilian artists who work in that style). Only apply the "bridge gradually" softening below when the listener\'s instruction is vague about genre (e.g. "slow it down", "more chill") rather than naming one explicitly.',
  'Abrupt jumps in genre, tempo or production style are FORBIDDEN only when there is no explicit genre/style request from the listener. If the listener\'s vague instruction demands a real style change, make the first suggested track a bridge that shares elements (tempo, instrumentation, mood) with both the old and new style; if the listener named a concrete genre, skip the bridge and go straight to that genre.',
  'When given the listener\'s recent listening history, treat it as a timeline (oldest to newest) and bridge from the most recent entry — immediate coherence with it outweighs everything except an explicit listener instruction. Never suggest a song or artist that already appears in that history.',
  'When given the listener\'s usual top genres, use them as a tiebreaker between otherwise-valid picks, but never let them override the golden rule of matching the current track\'s concrete style.',
  'Suggest only real, existing, commercially released songs that actually exist on Spotify, by real artists who actually work in that confirmed genre. Never invent tracks, and never guess a plausible-sounding title you are not confident is a real released song — if you are unsure a specific song exists, pick a different, well-known song by an artist in the same confirmed genre that you are certain is real.',
  'Never repeat the current artist or song.',
  'Rank your suggestions from most to least confident that they are real. Provide exactly 6, even if some are less certain — a downstream Spotify lookup will discard any that turn out not to exist, so more real candidates means more usable results.',
  'Respond with RAW JSON only (no markdown fences, no prose), exactly in this shape:',
  '{"tracks":[{"artist":"...","title":"...","why":"one short sentence naming the concrete genre/tempo/production trait shared with the current track"}]}',
].join(' ');

function buildUserPrompt({ track, artist, genres, history, topGenres, audioFeatures, feedback, mode, customPrompt }) {
  const parts = [];
  if (track || artist) {
    parts.push(`Current track: "${track || 'unknown'}" by ${artist || 'unknown artist'}.`);
  }
  if (Array.isArray(genres) && genres.length) {
    parts.push(`Confirmed Spotify genres for this artist: ${genres.join(', ')}. Use these as ground truth, not your own guess.`);
  } else if (track || artist) {
    parts.push('No confirmed genre data available — use your own knowledge of this specific real artist and song.');
  }
  if (audioFeatures && typeof audioFeatures.tempo === 'number') {
    parts.push(`Current track measured tempo ~${Math.round(audioFeatures.tempo)} BPM, energy ${audioFeatures.energy.toFixed(2)}, danceability ${audioFeatures.danceability.toFixed(2)} (0-1 scale, Spotify's own analysis — this is ground truth, not a guess).`);
  }
  if (Array.isArray(history) && history.length) {
    parts.push(`Listener's recent history, oldest to newest (last one is most recent): ${history.join(' | ')}.`);
  }
  if (Array.isArray(topGenres) && topGenres.length) {
    parts.push(`Listener's usual top genres overall: ${topGenres.join(', ')}.`);
  }
  if (feedback && Array.isArray(feedback.liked) && feedback.liked.length) {
    parts.push(`Listener actually played these past AI suggestions (bias toward similar style/artists): ${feedback.liked.join(' | ')}.`);
  }
  if (feedback && Array.isArray(feedback.skipped) && feedback.skipped.length) {
    parts.push(`Listener never played these past AI suggestions (avoid repeating this exact style/artist guess): ${feedback.skipped.join(' | ')}.`);
  }
  if (mode) {
    parts.push(`Session mode / vibe to respect alongside the golden rule: ${mode}.`);
  }
  if (customPrompt) {
    parts.push(`LISTENER'S EXPLICIT INSTRUCTION (top priority — see TOP PRIORITY OVERRIDE rule): "${customPrompt}". If this names a concrete genre/style, honour it exactly and directly rather than blending it with the current track's style.`);
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

  const { track, artist, genres, history, topGenres, audioFeatures, feedback, mode, customPrompt } = req.body || {};

  try {
    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.6,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt({ track, artist, genres, history, topGenres, audioFeatures, feedback, mode, customPrompt }) },
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
      .slice(0, 6)
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
