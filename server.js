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
// ─────────────────────────────────────────
async function pollLive() {
  // Try oref
  try {
    const res  = await fetch(OREF_LIVE, { headers: OREF_HEADERS, signal: AbortSignal.timeout(3000) });
    const text = await res.text();
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
    return; // oref worked — done
  } catch (_) {}

  // Fallback: tzevaadom live
  try {
    const res  = await fetch(TZEVA_LIVE, { signal: AbortSignal.timeout(3000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) {
      if (currentAlert !== null) { currentAlert = null; broadcast('alert_clear', {}); }
      return;
    }
    const newest = data[0];
    const id = String(newest.time);
    if (id !== lastAlertId) {
      lastAlertId  = id;
      currentAlert = { id, data: newest.cities||[], cat: newest.threat, title: '' };
      const entry  = { id, time: newest.time, cities: newest.cities||[], cat: newest.threat, title: '' };
      alertFeed.unshift(entry);
      if (alertFeed.length > 50) alertFeed.pop();
      broadcast('alert_new', currentAlert);
      broadcast('feed_update', alertFeed.slice(0, 20));
    }
  } catch (_) {}
}

setInterval(pollLive, 2000);
pollLive();

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
