const express = require('express');
const cookie = require('cookie');
const { COOKIE_NAME, createAuthCookieValue, isValidAuthCookie } = require('../lib/auth');
const { loginPage, indexPage } = require('../lib/pages');

const app = express();

// ---------- Grundkonfiguration ----------
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const MAX_CALL_DURATION_SECONDS = 12 * 60; // Gesprächslimit: 12 Minuten

const TAVUS_API_KEY = process.env.TAVUS_API_KEY;
// TODO: Platzhalter. Sobald PAL und Face in Tavus angelegt sind, als Vercel-Umgebungsvariable eintragen.
// Hinweis: Tavus nennt das inzwischen "PAL" (früher "Persona") und "Face" (früher "Replica").
const TAVUS_PAL_ID = process.env.TAVUS_PAL_ID;
const TAVUS_FACE_ID = process.env.TAVUS_FACE_ID;

// Zähler: läuft über Upstash Redis (als Vercel-Marketplace-Integration verbunden),
// weil eine normale Datei auf Vercel nicht dauerhaft gespeichert bleibt
// (jede Anfrage kann auf einer neuen, leeren Instanz landen).
// Hinweis: Vercels älteres "Vercel KV" ist inzwischen eingestellt, Upstash Redis
// ist der aktuell empfohlene Nachfolger, daher hier direkt so umgesetzt.
let redisClient = null;
function getRedis() {
  if (!redisClient) {
    const { Redis } = require('@upstash/redis');
    // Vercel benennt die Umgebungsvariablen je nach Integrationsversion leicht anders,
    // deshalb hier beide gängigen Varianten abfangen. Die tatsächlichen Namen zeigt
    // Vercel dir an, sobald du die Redis-Integration mit dem Projekt verbindest.
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}
const COUNTER_KEY = 'avadia:conducted';

async function readCounter() {
  try {
    const value = await getRedis().get(COUNTER_KEY);
    return typeof value === 'number' ? value : 0;
  } catch (err) {
    console.error('Redis-Lesefehler:', err.message);
    return 0;
  }
}

async function incrementCounter() {
  try {
    return await getRedis().incr(COUNTER_KEY);
  } catch (err) {
    console.error('Redis-Schreibfehler:', err.message);
    return 0;
  }
}

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function requireAuth(req, res, next) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const value = cookies[COOKIE_NAME];

  if (SESSION_SECRET && isValidAuthCookie(value, SESSION_SECRET)) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ status: 'error', message: 'Nicht eingeloggt.' });
  }
  return res.redirect('/login');
}

// ---------- Passwortschutz ----------
app.get('/login', (req, res) => {
  res.send(loginPage(req.query.error === '1'));
});

app.post('/login', (req, res) => {
  const submitted = req.body.password || '';

  if (!ACCESS_PASSWORD || !SESSION_SECRET) {
    return res.status(500).send('ACCESS_PASSWORD oder SESSION_SECRET fehlt in den Vercel-Umgebungsvariablen.');
  }

  if (submitted === ACCESS_PASSWORD) {
    const value = createAuthCookieValue(SESSION_SECRET);
    res.setHeader('Set-Cookie', cookie.serialize(COOKIE_NAME, value, {
      httpOnly: true,
      secure: true, // Vercel liefert immer über HTTPS aus
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 12 // 12 Stunden
    }));
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE_NAME, '', {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0
  }));
  res.redirect('/login');
});

// ---------- Geschützte Testseite ----------
app.get('/', requireAuth, (req, res) => {
  res.send(indexPage());
});

// ---------- API ----------
app.get('/api/stats', requireAuth, async (req, res) => {
  res.json({ conducted: await readCounter() });
});

app.post('/api/start-conversation', requireAuth, async (req, res) => {
  if (!TAVUS_API_KEY) {
    return res.status(500).json({ status: 'error', message: 'TAVUS_API_KEY fehlt in den Vercel-Umgebungsvariablen.' });
  }

  // Solange PAL/Face noch nicht angelegt sind, bleibt es beim Vorschau-Modus.
  // Passwortschutz, Zähler und das Verstecken des API-Schlüssels funktionieren aber schon vollständig echt.
  if (!TAVUS_PAL_ID || !TAVUS_FACE_ID) {
    const conducted = await incrementCounter();
    return res.json({
      status: 'not_configured',
      message: 'AVADIA ist noch nicht vollständig eingerichtet (PAL/Face fehlen).',
      conducted
    });
  }

  try {
    const tavusResponse = await fetch('https://tavusapi.com/v2/conversations', {
      method: 'POST',
      headers: {
        'x-api-key': TAVUS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        pal_id: TAVUS_PAL_ID,
        face_id: TAVUS_FACE_ID,
        properties: {
          // Ziel: das Gespräch automatisch nach 12 Minuten beenden.
          max_call_duration: MAX_CALL_DURATION_SECONDS,
          // Damit AVADIA von Anfang an auf Deutsch startet, statt dass
          // Testpersonen das im Gespräch manuell umstellen müssen.
          languages: ['de']
        }
      })
    });

    const data = await tavusResponse.json();

    if (!tavusResponse.ok) {
      return res.status(502).json({ status: 'error', message: data.message || 'Tavus hat die Anfrage abgelehnt.' });
    }

    const conducted = await incrementCounter();
    return res.json({ status: 'ok', conversation_url: data.conversation_url, conducted });

  } catch (err) {
    console.error(err);
    return res.status(502).json({ status: 'error', message: 'Verbindung zu Tavus ist fehlgeschlagen.' });
  }
});

// Für Vercel: die App wird als Funktion exportiert, kein eigenes app.listen().
module.exports = app;

// Nur für lokale Tests (z. B. mit "npm run dev") direkt per node ausführbar,
// auf Vercel selbst wird dieser Teil nie erreicht.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('Lokaler Testserver läuft auf Port ' + PORT));
}
