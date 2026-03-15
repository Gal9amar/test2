const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────
// Sources
// ─────────────────────────────────────────
const OREF_LIVE    = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const OREF_HIST    = 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json';
const TZEVA_HIST   = 'https://api.tzevaadom.co.il/alerts-history/';
const TZEVA_LIVE   = 'https://api.tzevaadom.co.il/notifications';
const OREF_HEADERS = {
  'Referer': 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0',
};

// ─────────────────────────────────────────
// SSE state
// ─────────────────────────────────────────
const sseClients = new Set();
let currentAlert = null;
let alertFeed    = [];
let lastAlertId  = null;

function broadcast(eventName, payload) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(res => {
    try { res.write(msg); } catch (_) {}
  });
}

// ─────────────────────────────────────────
// Live polling — oref first, tzevaadom fallback
// Polls every 10s (tzevaadom doesn't need 2s)
// ─────────────────────────────────────────
const ACTIVE_WINDOW = 5 * 60; // 5 minutes — treat alerts this recent as "active"

async function pollLive() {
  // 1. Try oref direct (works only from Israeli IP)
  try {
    const res   = await fetch(OREF_LIVE, { headers: OREF_HEADERS, signal: AbortSignal.timeout(3000) });
    const text  = await res.text();
    const clean = text.replace(/^\uFEFF/, '').trim();

    if (!clean || clean === '{}' || clean === '[]') {
      if (currentAlert !== null) { currentAlert = null; broadcast('alert_clear', {}); }
      return;
    }
    const data = JSON.parse(clean);
    if (!data?.id) return;
    if (data.id !== lastAlertId) {
      lastAlertId  = data.id;
      currentAlert = data;
      const entry = { id: data.id, time: Math.floor(Date.now()/1000), cities: data.data||[], cat: data.cat, title: data.title||'' };
      alertFeed.unshift(entry);
      if (alertFeed.length > 50) alertFeed.pop();
      broadcast('alert_new', data);
      broadcast('feed_update', alertFeed.slice(0, 20));
    }
    return; // oref worked
  } catch (_) {}

  // 2. Fallback: tzevaadom history — check last 5 min for new alerts
  try {
    const res  = await fetch(TZEVA_HIST, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return;

    const now     = Math.floor(Date.now() / 1000);
    const cutoff  = now - ACTIVE_WINDOW;

    // Flatten all recent alerts
    const recent = data
      .flatMap(e => (e.alerts||[]).filter(a => !a.isDrill && a.time >= cutoff))
      .sort((a, b) => b.time - a.time);

    if (!recent.length) {
      // Nothing in last 5 min — clear active if needed
      if (currentAlert !== null) { currentAlert = null; broadcast('alert_clear', {}); }
      return;
    }

    // Build feed from recent (deduplicate by time+cities key)
    const seen = new Set(alertFeed.map(e => e.id));
    let newEntries = 0;
    for (const a of recent) {
      const id = String(a.time) + '_' + (a.cities||[]).join(',');
      if (!seen.has(id)) {
        seen.add(id);
        const entry = { id, time: a.time, cities: a.cities||[], cat: a.threat, title: threatLabel(a.threat) };
        alertFeed.unshift(entry);
        newEntries++;
        // Broadcast each new alert
        broadcast('alert_new', { id, data: a.cities||[], cat: a.threat, title: entry.title });
      }
    }
    if (alertFeed.length > 50) alertFeed.length = 50;

    if (newEntries > 0) {
      broadcast('feed_update', alertFeed.slice(0, 20));
    }

    // Set currentAlert to most recent if within 5 min
    const latest = recent[0];
    const latestId = String(latest.time) + '_' + (latest.cities||[]).join(',');
    if (latestId !== lastAlertId) {
      lastAlertId  = latestId;
      currentAlert = { id: latestId, data: latest.cities||[], cat: latest.threat, title: threatLabel(latest.threat) };
      broadcast('alert_new', currentAlert);
    }

  } catch (_) {}
}

function threatLabel(cat) {
  const map = { 0: 'ירי רקטות וטילים', 1: 'חומרים מסוכנים', 2: 'רעידת אדמה', 3: 'פצצה לא מתפוצצת', 4: 'צונאמי', 5: 'חדירת כלי טיס עוין', 6: 'חדירת מחבלים', 7: 'אירוע רדיולוגי' };
  return map[cat] || 'התרעה';
}

setInterval(pollLive, 10000); // every 10s — tzevaadom doesn't need faster

// Pre-populate feed on startup so first SSE snapshot has data
async function initFeed() {
  try {
    const res  = await fetch(TZEVA_HIST, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    if (!Array.isArray(data)) return;

    const now    = Math.floor(Date.now() / 1000);
    const cutoff = now - 24 * 60 * 60; // last 24h for feed

    const alerts = data
      .flatMap(e => (e.alerts||[]).filter(a => !a.isDrill && a.time >= cutoff))
      .sort((a, b) => b.time - a.time)
      .slice(0, 50);

    alertFeed = alerts.map(a => ({
      id:     String(a.time) + '_' + (a.cities||[]).join(','),
      time:   a.time,
      cities: a.cities || [],
      cat:    a.threat,
      title:  threatLabel(a.threat),
    }));

    // Set lastAlertId to most recent so pollLive doesn't re-broadcast them
    if (alertFeed.length) {
      lastAlertId = alertFeed[0].id;
      // If most recent alert was within 5 min, set as currentAlert for map
      if (now - alertFeed[0].time < ACTIVE_WINDOW) {
        const a = alerts[0];
        currentAlert = { id: lastAlertId, data: a.cities||[], cat: a.threat, title: threatLabel(a.threat) };
      }
    }
    console.log(`[init] feed pre-populated: ${alertFeed.length} alerts`);
  } catch (e) {
    console.warn('[init] feed pre-population failed:', e.message);
  }
}

initFeed().then(() => pollLive());

// ─────────────────────────────────────────
// SSE endpoint  GET /api/stream
// ─────────────────────────────────────────
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  res.write(`event: snapshot\ndata: ${JSON.stringify({ currentAlert, feed: alertFeed.slice(0,20) })}\n\n`);

  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
  sseClients.add(res);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

// ─────────────────────────────────────────
// GET /api/history
// Normalized format: [{time, cities, threat, isDrill}]
// Tries oref, falls back to tzevaadom
// ─────────────────────────────────────────
let histCache   = null;
let histCacheAt = 0;
const HIST_TTL  = 60 * 1000;

app.get('/api/history', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const now = Date.now();
  if (histCache && now - histCacheAt < HIST_TTL) return res.json(histCache);

  // Try oref history
  try {
    const r    = await fetch(OREF_HIST, { headers: OREF_HEADERS, signal: AbortSignal.timeout(6000) });
    const data = await r.json();
    if (Array.isArray(data) && data.length) {
      // oref format: [{id, alerts:[{time,cities,threat,isDrill}]}]
      // flatten to array of alerts (same format frontend expects)
      const alerts = data.flatMap(e => (e.alerts||[]).filter(a => !a.isDrill));
      histCache   = alerts;
      histCacheAt = now;
      return res.json(alerts);
    }
  } catch (_) {}

  // Fallback: tzevaadom history (same structure as oref, just nested differently)
  try {
    const r    = await fetch(TZEVA_HIST, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    // tzevaadom format: [{id, alerts:[{time,cities,threat,isDrill}]}]
    const alerts = data.flatMap(e => (e.alerts||[]).filter(a => !a.isDrill));
    histCache   = alerts;
    histCacheAt = now;
    return res.json(alerts);
  } catch (_) {}

  if (histCache) return res.json(histCache);
  res.status(502).json([]);
});

// ─────────────────────────────────────────
// GET /api/historical-all  (tzevaadom full history for long-range stats)
// ─────────────────────────────────────────
let fullHistCache   = null;
let fullHistCacheAt = 0;
const FULL_HIST_TTL = 5 * 60 * 1000;

app.get('/api/historical-all', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const now = Date.now();
  if (fullHistCache && now - fullHistCacheAt < FULL_HIST_TTL) return res.json(fullHistCache);
  try {
    const r    = await fetch('https://www.tzevaadom.co.il/static/historical/all.json', {
      signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const data = await r.json();
    fullHistCache   = data;
    fullHistCacheAt = now;
    res.json(data);
  } catch (_) {
    if (fullHistCache) return res.json(fullHistCache);
    res.status(502).json([]);
  }
});

// ─────────────────────────────────────────
// Serve static files (index.html, etc.)
// ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`safetime server on :${PORT}`));
