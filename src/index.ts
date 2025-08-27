// ===== Goals4Arab Backend (Sportmonks v3) =====
// Works with Fastify v5 and @fastify/cors v10
// Start locally: npm run dev

const Fastify = require('fastify');
const cors = require('@fastify/cors');
const { request } = require('undici');
require('dotenv').config();

const app = Fastify({ logger: true });

// ---------------- tiny in-memory cache ----------------
type CacheEntry = { exp: number; data: any };
const cache: Record<string, CacheEntry> = {};
function put(k: string, data: any, ttlMs = 5000) {
  cache[k] = { exp: Date.now() + ttlMs, data };
}
function get(k: string) {
  const v = cache[k];
  return v && v.exp > Date.now() ? v.data : null;
}

// ------------- helpers to normalize fixtures -------------
function currentScore(scores: any[]) {
  let home = 0, away = 0;
  if (Array.isArray(scores)) {
    for (const s of scores) {
      if (s?.description === 'CURRENT') {
        if (s?.score?.participant === 'home') home = Number(s.score.goals ?? 0);
        if (s?.score?.participant === 'away') away = Number(s.score.goals ?? 0);
      }
    }
  }
  return { home, away };
}

function mapFixture(fx: any) {
  const parts = fx?.participants || [];
  const home = parts.find((p: any) => p?.meta?.location === 'home') || {};
  const away = parts.find((p: any) => p?.meta?.location === 'away') || {};
  const { home: score_home, away: score_away } = currentScore(fx?.scores || []);
  const league_name = fx?.league?.name ?? null;

  const kickoffUTC = fx?.starting_at ? fx.starting_at.replace(' ', 'T') + 'Z' : null;
  const kickoffBahrain = kickoffUTC
    ? new Date(kickoffUTC).toLocaleString('ar', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Bahrain',
      })
    : null;

  return {
    id: fx?.id,
    league_id: fx?.league_id,
    league_name,
    state_id: fx?.state_id,
    kickoff_utc: kickoffUTC,
    kickoff_bahrain: kickoffBahrain,
    home: { id: home?.id, name: home?.name, code: home?.short_code, logo: home?.image_path },
    away: { id: away?.id, name: away?.name, code: away?.short_code, logo: away?.image_path },
    score_home,
    score_away,
  };
}

function sortByKickoff(list: any[]) {
  return list.sort((a: any, b: any) =>
    new Date(a?.kickoff_utc || 0).getTime() - new Date(b?.kickoff_utc || 0).getTime()
  );
}

// ------------------- start server -------------------
async function start() {
  await app.register(cors, { origin: true });

  const PORT = Number(process.env.PORT || 8080);
  const API_BASE = process.env.API_BASE || 'https://api.sportmonks.com/v3/football';
  const API_KEY = process.env.API_KEY;

  if (!API_KEY) {
    app.log.error('Missing API_KEY in env');
    process.exit(1);
  }

  // Health
  app.get('/health', async () => ({ ok: true }));

  // ---------- A) Today's fixtures ----------
  app.get('/api/fixtures/today', async () => {
    const c = get('fixtures:today:simple');
    if (c) return c;

    const todayUTC = new Date().toISOString().slice(0, 10);
    const url =
      `${API_BASE}/fixtures/date/${todayUTC}` +
      `?api_token=${API_KEY}&include=participants;league;scores&locale=ar`;

    const res = await request(url);
    const raw = await res.body.json();

    const fixtures = sortByKickoff((raw?.data ?? []).map(mapFixture));
    const response = { date_utc: todayUTC, fixtures };
    put('fixtures:today:simple', response, 60_000); // cache 60s
    return response;
  });

  // ---------- B) Live now (in play only) ----------
  app.get('/api/live', async () => {
    const c = get('live:simple');
    if (c) return c;

    const url =
      `${API_BASE}/livescores/inplay` +
      `?api_token=${API_KEY}&include=participants;league;scores&locale=ar`;

    const res = await request(url);
    const raw = await res.body.json();

    const fixtures = sortByKickoff((raw?.data ?? []).map(mapFixture));
    const response = { count: fixtures.length, fixtures };
    put('live:simple', response, 5_000); // cache 5s
    return response;
  });

  // ---------- C) Fixtures by specific date ----------
  // Example: /api/fixtures/date/2025-08-27
  app.get('/api/fixtures/date/:date', async (req: any) => {
    const { date } = req.params; // YYYY-MM-DD
    const key = `fixtures:date:${date}`;
    const c = get(key);
    if (c) return c;

    const url =
      `${API_BASE}/fixtures/date/${date}` +
      `?api_token=${API_KEY}&include=participants;league;scores&locale=ar`;

    const res = await request(url);
    const raw = await res.body.json();
    const fixtures = sortByKickoff((raw?.data ?? []).map(mapFixture));

    const response = { date_utc: date, fixtures };
    put(key, response, 60_000);
    return response;
  });

  // ---------- D) Tomorrow shortcut ----------
  app.get('/api/fixtures/tomorrow', async () => {
    const c = get('fixtures:tomorrow');
    if (c) return c;

    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    const date = d.toISOString().slice(0, 10);

    const url =
      `${API_BASE}/fixtures/date/${date}` +
      `?api_token=${API_KEY}&include=participants;league;scores&locale=ar`;

    const res = await request(url);
    const raw = await res.body.json();
    const fixtures = sortByKickoff((raw?.data ?? []).map(mapFixture));
    const response = { date_utc: date, fixtures };
    put('fixtures:tomorrow', response, 60_000);
    return response;
  });

  // ---------- E) Upcoming schedule (next N days) ----------
  // Example: /api/fixtures/upcoming?days=7  (max 14)
  app.get('/api/fixtures/upcoming', async (req: any) => {
    const days = Math.max(1, Math.min(14, Number(req?.query?.days ?? 7)));
    const key = `fixtures:upcoming:${days}`;
    const cached = get(key);
    if (cached) return cached;

    const out: any[] = [];
    const today = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + i
      ));
      const date = d.toISOString().slice(0, 10);

      const url =
        `${API_BASE}/fixtures/date/${date}` +
        `?api_token=${API_KEY}&include=participants;league;scores&locale=ar`;

      const res = await request(url);
      const raw = await res.body.json();
      const fixtures = (raw?.data ?? []).map(mapFixture);
      if (fixtures.length) out.push({ date_utc: date, fixtures: sortByKickoff(fixtures) });
    }

    const response = { days, schedule: out };
    put(key, response, 60_000);
    return response;
  });

  // ---------- F) (Optional) Raw match details by ID ----------
  app.get('/api/matches/:id', async (req: any) => {
    const { id } = req.params;
    const key = `match:${id}`;
    const c = get(key);
    if (c) return c;

    const url =
      `${API_BASE}/fixtures/${id}` +
      `?api_token=${API_KEY}&include=participants;events;scores&locale=ar`;

    const res = await request(url);
    const raw = await res.body.json();
    put(key, raw, 3_000);
    return raw;
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Server listening on port ${PORT}`);
}

start().catch((err: any) => {
  console.error(err);
  process.exit(1);
});
