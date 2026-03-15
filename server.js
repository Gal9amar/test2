const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────
// oref polling state
// ─────────────────────────────────────────
const OREF_LIVE    = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const OREF_HIST    = 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json';
const OREF_HEADERS = {
  'Referer': 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0',
};

// SSE clients
const sseClients = new Set();

// Live alert state — sent to new SSE connections as initial snapshot
let currentAlert = null;      // { id, data:[], cat, title, desc } or null
let alertFeed    = [];        // last 50 alerts [{id,time,cities,cat,title}]
let lastAlertId  = null;

// ─────────────────────────────────────────
// Broadcast to all SSE clients
// ─────────────────────────────────────────
function broadcast(eventName, payload) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(res => {
    try { res.write(msg); } catch (_) {}
  });
}

// ─────────────────────────────────────────
// Poll oref for live alerts (every 2s)
// ─────────────────────────────────────────
async function pollLive() {
  try {
    const res = await fetch(OREF_LIVE, { headers: OREF_HEADERS, signal: AbortSignal.timeout(4000) });
    const text = await res.text();
    const clean = text.replace(/^\uFEFF/, '').trim();

    if (!clean || clean === '{}' || clean === '[]') {
      // No active alert
      if (currentAlert !== null) {
        currentAlert = null;
        broadcast('alert_clear', {});
      }
      return;
    }

    const data = JSON.parse(clean);
    if (!data || !data.id) return;

    if (data.id !== lastAlertId) {
      lastAlertId  = data.id;
      currentAlert = data;

      // Add to feed
      const entry = {
        id:    data.id,
        time:  Math.floor(Date.now() / 1000),
        cities: data.data || [],
        cat:   data.cat,
        title: data.title || '',
      };
      alertFeed.unshift(entry);
      if (alertFeed.length > 50) alertFeed.pop();

      broadcast('alert_new', data);
      broadcast('feed_update', alertFeed.slice(0, 20));
    }
  } catch (e) {
    // oref unreachable — don't crash
  }
}

setInterval(pollLive, 2000);
pollLive(); // immediate first call

// ─────────────────────────────────────────
// SSE endpoint  GET /api/stream
// ─────────────────────────────────────────
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send snapshot immediately so new clients are up to date
  const snapshot = {
    currentAlert,
    feed: alertFeed.slice(0, 20),
  };
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  // Heartbeat every 15s to keep connection alive
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 15000);

  sseClients.add(res);

  req.on('close', () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
});

// ─────────────────────────────────────────
// Proxy: history  GET /api/history
// Returns last 48h from oref
// ─────────────────────────────────────────
let histCache    = null;
let histCacheAt  = 0;
const HIST_TTL   = 60 * 1000; // 1 min cache

app.get('/api/history', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const now = Date.now();
    if (histCache && now - histCacheAt < HIST_TTL) {
      return res.json(histCache);
    }
    const r = await fetch(OREF_HIST, { headers: OREF_HEADERS, signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    histCache   = data;
    histCacheAt = now;
    res.json(data);
  } catch (e) {
    // Fallback: return cached even if stale
    if (histCache) return res.json(histCache);
    res.status(502).json({ error: 'oref unreachable' });
  }
});

// ─────────────────────────────────────────
// Proxy: historical full JSON from tzevaadom
// GET /api/historical-all
// (still needed for the long-range stats)
// ─────────────────────────────────────────
let fullHistCache   = null;
let fullHistCacheAt = 0;
const FULL_HIST_TTL = 5 * 60 * 1000; // 5 min

app.get('/api/historical-all', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const now = Date.now();
    if (fullHistCache && now - fullHistCacheAt < FULL_HIST_TTL) {
      return res.json(fullHistCache);
    }
    const r = await fetch('https://www.tzevaadom.co.il/static/historical/all.json', {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const data = await r.json();
    fullHistCache   = data;
    fullHistCacheAt = now;
    res.json(data);
  } catch (e) {
    if (fullHistCache) return res.json(fullHistCache);
    res.status(502).json({ error: 'source unreachable' });
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
