import 'dotenv/config';
import express from 'express';
import { google } from 'googleapis';
import * as reminders from './caldav.js';
import * as bridge from './bridge.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const CALENDAR_ID = process.env.CALENDAR_ID || 'primary';
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES || 3);
const TOKEN_PATH = path.join(__dirname, 'token.json');
const PHOTOS_DIR = path.join(__dirname, 'photos');
// Demo mode: run the whole UI with fake events + photos, no Google login needed.
// Auto-enabled when no Google credentials are configured (e.g. building the UI).
const DEMO =
  process.env.DEMO === '1' ||
  !process.env.GOOGLE_CLIENT_ID ||
  !process.env.GOOGLE_CLIENT_SECRET;

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

// ---- Google OAuth ----------------------------------------------------------
function makeOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.warn('No Google credentials in .env — start with DEMO=1 to work on the UI.');
    return null;
  }
  const client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI || `http://localhost:${PORT}/api/auth/callback`
  );
  if (fs.existsSync(TOKEN_PATH)) {
    client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
  }
  // Persist refreshed tokens automatically.
  client.on('tokens', (tokens) => {
    const existing = fs.existsSync(TOKEN_PATH)
      ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
      : {};
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }, null, 2));
  });
  return client;
}

const oauth = DEMO ? null : makeOAuthClient();
const calendar = oauth ? google.calendar({ version: 'v3', auth: oauth }) : null;

function isAuthed() {
  return !!oauth && fs.existsSync(TOKEN_PATH) && !!oauth.credentials.refresh_token;
}

// ---- Demo data -------------------------------------------------------------
// In-memory sample calendar so the UI is fully clickable without Google.
function seedDemoEvents() {
  const at = (dayOffset, h, m) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const iso = (d) => d.toISOString();
  const ymd = (dayOffset) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    return d.toISOString().slice(0, 10);
  };
  let id = 1;
  const timed = (dayOffset, h, m, dur, summary) => ({
    id: 'demo-' + id++,
    summary,
    start: { dateTime: iso(at(dayOffset, h, m)) },
    end: { dateTime: iso(at(dayOffset, h, m + dur)) },
  });
  const allDay = (dayOffset, summary) => ({
    id: 'demo-' + id++,
    summary,
    start: { date: ymd(dayOffset) },
    end: { date: ymd(dayOffset + 1) },
  });
  return [
    timed(0, 8, 0, 30, 'School drop-off'),
    timed(0, 15, 30, 60, 'Soccer practice ⚽'),
    timed(0, 18, 30, 60, 'Family dinner'),
    allDay(1, 'Library books due'),
    timed(1, 9, 0, 45, 'Dentist — Mia'),
    timed(2, 12, 0, 60, 'Lunch with Grandma'),
    allDay(3, 'No school — teacher day'),
    timed(4, 19, 0, 120, 'Movie night 🍿'),
    timed(6, 10, 0, 180, 'Farmers market'),
  ];
}
let demoEvents = DEMO ? seedDemoEvents() : [];

// ---- App -------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ authed: DEMO || isAuthed(), demo: DEMO, idleMinutes: IDLE_MINUTES });
});

app.get('/api/auth/login', (req, res) => {
  if (!oauth) return res.status(400).send('No Google credentials configured.');
  const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  res.redirect(url);
});

app.get('/api/auth/callback', async (req, res) => {
  try {
    const { tokens } = await oauth.getToken(req.query.code);
    oauth.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    res.send('<h1>Connected. You can close this tab.</h1><script>setTimeout(()=>window.close(),1500)</script>');
  } catch (e) {
    console.error(e);
    res.status(500).send('Auth failed: ' + e.message);
  }
});

// List events in a time window.
app.get('/api/events', async (req, res) => {
  if (DEMO) {
    const min = req.query.timeMin ? new Date(req.query.timeMin) : new Date(0);
    const max = req.query.timeMax ? new Date(req.query.timeMax) : new Date(8.64e15);
    const start = (e) => new Date(e.start.dateTime || e.start.date + 'T00:00:00');
    return res.json(
      demoEvents.filter((e) => start(e) >= min && start(e) <= max).sort((a, b) => start(a) - start(b))
    );
  }
  try {
    const timeMin = req.query.timeMin || new Date().toISOString();
    const { data } = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax: req.query.timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 500,
    });
    res.json(data.items || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create an event. Body: { summary, start, end, allDay }
app.post('/api/events', async (req, res) => {
  const { summary, start, end, allDay } = req.body;
  const event = { summary };
  if (allDay) { event.start = { date: start }; event.end = { date: end || start }; }
  else { event.start = { dateTime: start }; event.end = { dateTime: end }; }
  if (DEMO) {
    event.id = 'demo-' + Date.now();
    demoEvents.push(event);
    return res.json(event);
  }
  try {
    const { data } = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: event });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  if (DEMO) {
    demoEvents = demoEvents.filter((e) => e.id !== req.params.id);
    return res.json({ ok: true });
  }
  try {
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Photo gallery: demo photos live in public/demo; real ones in ./photos
app.get('/api/photos', (req, res) => {
  if (DEMO) return res.json(['/demo/photo1.svg', '/demo/photo2.svg', '/demo/photo3.svg']);
  if (!fs.existsSync(PHOTOS_DIR)) return res.json([]);
  const files = fs
    .readdirSync(PHOTOS_DIR)
    .filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f))
    .map((f) => '/photos/' + encodeURIComponent(f));
  res.json(files);
});
app.use('/photos', express.static(PHOTOS_DIR));

// ---- Shopping / Costco lists (Apple Reminders via iCloud CalDAV) ------------
// Demo store so the UI works without Apple credentials — one array per list.
const demoLists = DEMO
  ? {
      Shopping: [
        { uid: 'd1', title: 'Milk', done: false },
        { uid: 'd2', title: 'Eggs', done: false },
        { uid: 'd3', title: 'Bananas 🍌', done: false },
        { uid: 'd4', title: 'Bread', done: false },
        { uid: 'd5', title: 'Coffee ☕', done: true },
      ],
      Costco: [
        { uid: 'c1', title: 'Rotisserie chicken 🍗', done: false },
        { uid: 'c2', title: 'Paper towels', done: false },
        { uid: 'c3', title: 'Olive oil', done: false },
        { uid: 'c4', title: 'Kirkland coffee', done: true },
      ],
    }
  : {};
const DEMO_LIST_NAMES = ['Shopping', 'Costco'];

// Where list data comes from:
//   demo   – in-memory sample lists (UI building)
//   bridge – iPad Shortcuts bridge (shared Apple Reminders; the working path here)
//   caldav – direct iCloud CalDAV (only works for non-shared lists)
//   none   – not configured
const LIST_MODE =
  process.env.LIST_MODE ||
  (DEMO ? 'demo' : reminders.caldavConfigured() ? 'caldav' : 'none');

// A tiny adapter so demo lists share the same interface as bridge/caldav.
const demoBackend = {
  listNames: () => DEMO_LIST_NAMES,
  getItems: (name) => demoLists[name] || [],
  addItem: (name, title) => {
    const item = { uid: 'x' + Date.now(), title, done: false };
    (demoLists[name] ||= []).push(item);
    return item;
  },
  setDone: (name, uid, done) => {
    const item = (demoLists[name] || []).find((i) => i.uid === uid);
    if (item) item.done = done;
    return { uid, done };
  },
  removeItem: (name, uid) => {
    demoLists[name] = (demoLists[name] || []).filter((i) => i.uid !== uid);
    return { ok: true };
  },
};

// Pick the backend for list operations. bridge + demo are synchronous; caldav is
// async (network) — Promise.resolve() lets us await all three uniformly.
function listBackend() {
  if (LIST_MODE === 'bridge') return bridge;
  if (LIST_MODE === 'caldav') return reminders;
  if (LIST_MODE === 'demo') return demoBackend;
  return null;
}

app.get('/api/lists', (req, res) => {
  const b = listBackend();
  if (!b) return res.json({ configured: false, names: [] });
  res.json({ configured: true, mode: LIST_MODE, names: b.listNames() });
});

app.get('/api/list/:name', async (req, res) => {
  const b = listBackend();
  const name = req.params.name;
  if (!b) return res.json({ configured: false, name, items: [] });
  try {
    res.json({ configured: true, name, items: await Promise.resolve(b.getItems(name)) });
  } catch (e) {
    res.status(500).json({ configured: true, name, error: e.message, items: [] });
  }
});

app.post('/api/list/:name', async (req, res) => {
  const b = listBackend();
  const title = (req.body.title || '').trim();
  if (!b) return res.status(400).json({ error: 'Lists not configured' });
  if (!title) return res.status(400).json({ error: 'Empty title' });
  try { res.json(await Promise.resolve(b.addItem(req.params.name, title))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/list/:name/:uid', async (req, res) => {
  const b = listBackend();
  if (!b) return res.status(400).json({ error: 'Lists not configured' });
  try { res.json(await Promise.resolve(b.setDone(req.params.name, req.params.uid, !!req.body.done))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/list/:name/:uid', async (req, res) => {
  const b = listBackend();
  if (!b) return res.status(400).json({ error: 'Lists not configured' });
  try { res.json(await Promise.resolve(b.removeItem(req.params.name, req.params.uid))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- iPad bridge endpoints (Shortcuts talks to these) ----------------------
// Optional shared secret so only your iPad can push/pull.
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
function bridgeAuth(req, res, next) {
  if (BRIDGE_TOKEN && req.get('x-bridge-token') !== BRIDGE_TOKEN) {
    return res.status(401).json({ error: 'bad or missing x-bridge-token' });
  }
  next();
}

// iPad reports the current Reminders state. Body: { lists: { Shopping: [{title,done}], ... } }
app.post('/api/bridge/push', bridgeAuth, (req, res) => {
  bridge.setMirror(req.body.lists || {});
  res.json({ ok: true, ...bridge.status() });
});
// iPad pulls the wall's pending edits, applies them to Reminders, then acks.
app.get('/api/bridge/pull', bridgeAuth, (req, res) => res.json(bridge.pullOps()));
app.post('/api/bridge/ack', bridgeAuth, (req, res) =>
  res.json(bridge.ackOps(Number(req.body.token) || 0)));
app.get('/api/bridge/status', bridgeAuth, (req, res) => res.json(bridge.status()));

// ---- Weather (Open-Meteo, free, no API key) --------------------------------
const LAT = process.env.WEATHER_LAT;
const LON = process.env.WEATHER_LON;
const TEMP_UNIT = (process.env.TEMP_UNIT || 'fahrenheit').toLowerCase();
let weatherCache = { at: 0, data: null };

// Map WMO weather codes to an emoji + short label.
function wmo(code) {
  if (code === 0) return ['☀️', 'Clear'];
  if ([1, 2].includes(code)) return ['🌤️', 'Partly cloudy'];
  if (code === 3) return ['☁️', 'Cloudy'];
  if ([45, 48].includes(code)) return ['🌫️', 'Fog'];
  if ([51, 53, 55, 56, 57].includes(code)) return ['🌦️', 'Drizzle'];
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return ['🌧️', 'Rain'];
  if ([71, 73, 75, 77, 85, 86].includes(code)) return ['❄️', 'Snow'];
  if ([95, 96, 99].includes(code)) return ['⛈️', 'Storm'];
  return ['🌡️', 'Weather'];
}

// Representative hours for the time-of-day breakdown.
const DAY_PARTS = [
  { key: 'morning', label: 'Morning', hour: 8 },
  { key: 'midday', label: 'Midday', hour: 13 },
  { key: 'evening', label: 'Evening', hour: 18 },
  { key: 'night', label: 'Night', hour: 22 },
];

function demoWeather() {
  // 7-day synthetic forecast with a plausible hourly temperature curve.
  const codes = [0, 1, 2, 61, 3, 80, 1];
  const daily = codes.map((code, i) => {
    const d = new Date(); d.setDate(d.getDate() + i);
    const [emoji] = wmo(code);
    const base = 62 - i, swing = 16;
    // Diurnal curve: coolest ~5am, warmest ~3pm.
    const hourly = Array.from({ length: 24 }, (_, h) => {
      const t = Math.round(base + swing * Math.sin(((h - 9) / 24) * 2 * Math.PI) * 0.5 + swing * 0.5);
      const p = [61, 80].includes(code) ? Math.max(0, Math.round(60 * Math.sin((h / 24) * Math.PI))) : (h % 7) * 4;
      return { h, t, p };
    });
    const temps = hourly.map((x) => x.t);
    const parts = DAY_PARTS.map((pp) => {
      const hr = hourly[pp.hour];
      return { key: pp.key, label: pp.label, temp: hr.t, pop: hr.p, emoji };
    });
    return {
      date: d.toISOString().slice(0, 10), code, emoji,
      hi: Math.max(...temps), lo: Math.min(...temps), parts, hourly,
    };
  });
  const [emoji, text] = wmo(codes[0]);
  return { temp: 72, feels: 74, code: codes[0], hi: daily[0].hi, lo: daily[0].lo, emoji, text, daily, demo: true };
}

app.get('/api/weather', async (req, res) => {
  if (DEMO && (!LAT || !LON)) return res.json(demoWeather());
  if (!LAT || !LON) return res.json({ unavailable: true });
  // Cache for 15 minutes.
  if (Date.now() - weatherCache.at < 15 * 60 * 1000 && weatherCache.data) {
    return res.json(weatherCache.data);
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
      `&current=temperature_2m,apparent_temperature,weather_code` +
      `&hourly=temperature_2m,weather_code,precipitation_probability` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
      `&forecast_days=7&temperature_unit=${TEMP_UNIT}&timezone=auto`;
    const r = await fetch(url);
    const j = await r.json();
    const [emoji, text] = wmo(j.current.weather_code);

    // Index hourly data by date -> hour.
    const byDate = {};
    j.hourly.time.forEach((iso, i) => {
      const [date, hm] = iso.split('T');
      const hour = Number(hm.slice(0, 2));
      (byDate[date] ||= {})[hour] = {
        t: j.hourly.temperature_2m[i],
        p: j.hourly.precipitation_probability?.[i] ?? 0,
        c: j.hourly.weather_code[i],
      };
    });

    const daily = j.daily.time.map((date, i) => {
      const [dEmoji] = wmo(j.daily.weather_code[i]);
      const hrs = byDate[date] || {};
      const hourly = Array.from({ length: 24 }, (_, h) => ({
        h, t: Math.round(hrs[h]?.t ?? j.daily.temperature_2m_min[i]), p: hrs[h]?.p ?? 0,
      }));
      const parts = DAY_PARTS.map((pp) => {
        const hr = hrs[pp.hour];
        const [pEmoji] = wmo(hr ? hr.c : j.daily.weather_code[i]);
        return {
          key: pp.key, label: pp.label,
          temp: Math.round(hr?.t ?? j.daily.temperature_2m_max[i]),
          pop: hr?.p ?? 0, emoji: pEmoji,
        };
      });
      return {
        date, code: j.daily.weather_code[i], emoji: dEmoji,
        hi: Math.round(j.daily.temperature_2m_max[i]),
        lo: Math.round(j.daily.temperature_2m_min[i]),
        parts, hourly,
      };
    });

    const data = {
      temp: j.current.temperature_2m,
      feels: j.current.apparent_temperature,
      code: j.current.weather_code,
      hi: daily[0].hi, lo: daily[0].lo, emoji, text, daily,
    };
    weatherCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.json({ unavailable: true, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Family Calendar running at http://localhost:${PORT}${DEMO ? '  [DEMO MODE]' : ''}`);
  if (!DEMO && !isAuthed()) console.log('Not connected to Google yet — open the app and tap "Connect Google".');
});
