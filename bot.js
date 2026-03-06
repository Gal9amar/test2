const https = require('https');
const http = require('http');

const TOKEN = process.env.BOT_TOKEN || '8621396960:AAGK-xk2nixwvrgi1FllQvRg9oMd82ttcQA';

// ── Local history store ───────────────────────────────────────
const alertHistory = [];
const MAX_HISTORY = 5000;
const geoCache = {}; // city name → {lat, lon}

// ── Subscribers ───────────────────────────────────────────────
const subscribers = new Set();
let lastAlertId = null;

// ── Keyboard ──────────────────────────────────────────────────
const MAIN_KEYBOARD = {
  keyboard: [
    ['🚨 אזעקות עכשיו', '📊 סטטיסטיקות 24 שעות'],
    ['🔔 הרשם להתראות', '🔕 הפסק התראות'],
    ['🔍 חיפוש לפי עיר']
  ],
  resize_keyboard: true,
  persistent: true
};

// ── Telegram helpers ──────────────────────────────────────────
function tgRequest(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendMessage(chatId, text, extra = {}) {
  return tgRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

function sendWithKeyboard(chatId, text) {
  return sendMessage(chatId, text, { reply_markup: MAIN_KEYBOARD });
}

function sendLocation(chatId, lat, lon, title) {
  // Send interactive map pin — opens in Google Maps / Waze / Apple Maps
  return tgRequest('sendVenue', {
    chat_id: chatId,
    latitude: lat,
    longitude: lon,
    title: title,
    address: 'לחץ לפתיחה במפה',
  });
}

// ── Geocoding via Nominatim (free, no key) ────────────────────
function geocodeCity(cityName) {
  // Strip area qualifiers like "תל אביב - מרכז העיר" → "תל אביב"
  const cleanName = cityName.split(' - ')[0].trim();

  if (geoCache[cleanName]) return Promise.resolve(geoCache[cleanName]);

  return new Promise((resolve) => {
    const query = encodeURIComponent(cleanName + ' ישראל');
    const req = https.request({
      hostname: 'nominatim.openstreetmap.org',
      path: `/search?q=${query}&countrycodes=il&format=json&limit=1`,
      method: 'GET',
      headers: {
        'User-Agent': 'OrefAlertsBot/1.0 (Telegram bot for Israeli alerts)',
        'Accept-Language': 'he'
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data && data[0]) {
            const result = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
            geoCache[cleanName] = result;
            resolve(result);
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Oref fetch ────────────────────────────────────────────────
function fetchCurrentAlert() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.oref.org.il',
      path: '/WarningMessages/alert/alerts.json',
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'he-IL,he;q=0.9',
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Host': 'www.oref.org.il'
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (!body || body.trim().startsWith('<') || body.trim() === '') return resolve(null);
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Helpers ───────────────────────────────────────────────────
function getLast24h() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return alertHistory.filter(a => a.timestamp >= cutoff);
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
}
function formatDate(ts) {
  return new Date(ts).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

// ── Commands ──────────────────────────────────────────────────
async function cmdStart(chatId) {
  subscribers.add(chatId);
  await sendWithKeyboard(chatId,
    `🚨 <b>בוט אזעקות פיקוד העורף</b>\n\n` +
    `ברוך הבא! נרשמת לקבל התראות בזמן אמת ✅\n\n` +
    `בכל אזעקה תקבל:\n` +
    `• הודעה עם שם האזור\n` +
    `• 📍 פין מפה אינטראקטיבי\n\n` +
    `השתמש במקלדת למטה:`
  );
}

async function cmdStop(chatId) {
  subscribers.delete(chatId);
  await sendWithKeyboard(chatId, '🔕 הוסרת מרשימת ההתראות.');
}

async function cmdSubscribe(chatId) {
  subscribers.add(chatId);
  await sendWithKeyboard(chatId, '🔔 נרשמת! תקבל התראה + מפה על כל אזעקה ✅');
}

async function cmdNow(chatId) {
  const alert = await fetchCurrentAlert();
  if (!alert || !alert.data || alert.data.length === 0) {
    await sendWithKeyboard(chatId, '✅ אין אזעקות פעילות כרגע.');
    return;
  }
  const cities = alert.data.join('\n• ');
  await sendWithKeyboard(chatId,
    `🚨 <b>אזעקה פעילה עכשיו!</b>\n\n` +
    `📋 <b>${alert.title || 'התרעה'}</b>\n\n` +
    `📍 <b>אזורים:</b>\n• ${cities}`
  );
  // Send map for first city
  const geo = await geocodeCity(alert.data[0]);
  if (geo) await sendLocation(chatId, geo.lat, geo.lon, alert.data[0]);
}

async function cmdStats(chatId) {
  const recent = getLast24h();
  if (recent.length === 0) {
    const uptime = Math.round(process.uptime() / 60);
    await sendWithKeyboard(chatId,
      `📊 <b>סטטיסטיקות 24 שעות</b>\n\n` +
      (uptime < 60
        ? `הבוט רץ ${uptime} דקות — עוד לא נצברה היסטוריה.\nברגע שתהיה אזעקה, היא תירשם אוטומטית 🔄`
        : `✅ לא היו אזעקות ב-24 השעות האחרונות.`)
    );
    return;
  }

  const cityCount = {};
  recent.forEach(a => {
    (Array.isArray(a.data) ? a.data : [a.data]).forEach(city => {
      if (city) cityCount[city] = (cityCount[city] || 0) + 1;
    });
  });

  const sorted = Object.entries(cityCount).sort((a, b) => b[1] - a[1]);
  let msg = `📊 <b>סטטיסטיקות 24 שעות אחרונות</b>\n\n`;
  msg += `🔢 סה"כ אזעקות: <b>${recent.length}</b>\n`;
  msg += `🏙️ יישובים: <b>${sorted.length}</b>\n\n`;
  msg += `<b>🏆 Top יישובים:</b>\n`;
  sorted.slice(0, 15).forEach(([city, count], i) => {
    msg += `${i + 1}. ${city} — <b>${count}</b>\n`;
  });
  await sendWithKeyboard(chatId, msg);
}

async function cmdCityPrompt(chatId) {
  await sendMessage(chatId, '🔍 שלח את שם העיר לחיפוש:', {
    reply_markup: { force_reply: true, input_field_placeholder: 'שם העיר...' }
  });
}

async function cmdCity(chatId, cityName) {
  if (!cityName) { await cmdCityPrompt(chatId); return; }

  const recent = getLast24h();
  const matches = recent.filter(a => {
    const cities = Array.isArray(a.data) ? a.data : [a.data];
    return cities.some(c => c && c.includes(cityName));
  });

  if (matches.length === 0) {
    await sendWithKeyboard(chatId,
      `🔍 לא נמצאו אזעקות עבור "<b>${cityName}</b>" ב-24 שעות האחרונות.\n` +
      (recent.length > 0 ? `(סה"כ ${recent.length} אזעקות נרשמו)` : `(הבוט עוד לא צבר היסטוריה)`)
    );
    return;
  }

  let msg = `📍 <b>${cityName}</b> — ${matches.length} אזעקות (24 שעות)\n\n`;
  matches.slice(0, 20).forEach(a => {
    msg += `🕐 ${formatDate(a.timestamp)} ${formatTime(a.timestamp)} — ${a.title || 'אזעקה'}\n`;
  });
  if (matches.length > 20) msg += `\n...ועוד ${matches.length - 20} נוספות`;

  await sendWithKeyboard(chatId, msg);

  // Send map location
  const geo = await geocodeCity(cityName);
  if (geo) await sendLocation(chatId, geo.lat, geo.lon, cityName);
}

// ── Route messages ────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (text === '/start' || text.startsWith('/start '))        return cmdStart(chatId);
  if (text === '/stop')                                        return cmdStop(chatId);
  if (text === '/now'   || text === '🚨 אזעקות עכשיו')        return cmdNow(chatId);
  if (text === '/stats' || text === '📊 סטטיסטיקות 24 שעות') return cmdStats(chatId);
  if (text === '🔔 הרשם להתראות')                             return cmdSubscribe(chatId);
  if (text === '🔕 הפסק התראות')                              return cmdStop(chatId);
  if (text === '🔍 חיפוש לפי עיר')                           return cmdCityPrompt(chatId);
  if (text.startsWith('/city'))
    return cmdCity(chatId, text.replace('/city', '').replace(/@\w+/, '').trim());
  if (text && !text.startsWith('/'))
    return cmdCity(chatId, text);

  await sendWithKeyboard(chatId, '❓ השתמש במקלדת למטה.');
}

// ── Real-time alert polling ───────────────────────────────────
async function pollAlerts() {
  try {
    const alert = await fetchCurrentAlert();
    if (!alert || !alert.data || alert.data.length === 0) {
      lastAlertId = null;
      return;
    }

    const alertId = String(alert.id || alert.data.join(','));
    if (alertId === lastAlertId) return;
    lastAlertId = alertId;

    alertHistory.unshift({
      timestamp: Date.now(),
      title: alert.title || 'התרעה',
      data: alert.data,
      id: alertId
    });
    if (alertHistory.length > MAX_HISTORY) alertHistory.pop();

    console.log(`🚨 Alert: ${alert.data.join(', ')}`);
    if (subscribers.size === 0) return;

    const now = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
    const cities = alert.data.join('\n• ');

    // 1. Push alert message (no buttons)
    const alertMsg =
      `🚨🚨🚨 <b>אזעקה!</b> 🚨🚨🚨\n\n` +
      `📋 <b>${alert.title || 'התרעת פיקוד העורף'}</b>\n\n` +
      `📍 <b>אזורים:</b>\n• ${cities}\n\n` +
      `🕐 ${now}`;

    for (const chatId of subscribers) {
      sendMessage(chatId, alertMsg).catch(() => {});
    }

    // 2. Geocode first city and send map pin to all subscribers
    const firstCity = alert.data[0];
    if (firstCity) {
      const geo = await geocodeCity(firstCity);
      if (geo) {
        for (const chatId of subscribers) {
          sendLocation(chatId, geo.lat, geo.lon, firstCity).catch(() => {});
        }
        console.log(`📍 Map sent for ${firstCity}: ${geo.lat}, ${geo.lon}`);
      }
    }

  } catch (err) {
    console.error('Poll error:', err.message);
  }
}

// ── Long polling ──────────────────────────────────────────────
let offset = 0;

async function getUpdates() {
  try {
    const res = await tgRequest('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
    if (!res.ok || !res.result) return;
    for (const update of res.result) {
      offset = update.update_id + 1;
      if (update.message) await handleMessage(update.message).catch(console.error);
    }
  } catch (err) {
    console.error('getUpdates error:', err.message);
    await new Promise(r => setTimeout(r, 3000));
  }
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('🤖 Oref Bot starting...');
  await tgRequest('deleteWebhook', {});
  const me = await tgRequest('getMe', {});
  if (me.result) console.log(`✅ @${me.result.username}`);

  setInterval(pollAlerts, 2000);
  const loop = async () => { await getUpdates(); setImmediate(loop); };
  loop();

  http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      subscribers: subscribers.size,
      history: alertHistory.length,
      geoCached: Object.keys(geoCache).length,
      uptime: Math.round(process.uptime())
    }));
  }).listen(process.env.PORT || 3001, () => console.log(`✅ Health on :${process.env.PORT || 3001}`));
}

main().catch(console.error);
