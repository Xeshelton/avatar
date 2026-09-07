require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();

// ---------- Grundkonfiguration ----------
const PORT = process.env.PORT || 3000;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || 'bitte-in-.env-eintragen';
const MAX_CALL_DURATION_SECONDS = 12 * 60; // Gesprächslimit: 12 Minuten

const TAVUS_API_KEY = process.env.TAVUS_API_KEY;
// TODO: Platzhalter. Sobald Persona/Replica in Tavus angelegt sind, in der .env eintragen.
const TAVUS_PERSONA_ID = process.env.TAVUS_PERSONA_ID;
const TAVUS_REPLICA_ID = process.env.TAVUS_REPLICA_ID;

const COUNTER_FILE = path.join(__dirname, 'data', 'counter.json');

if (!ACCESS_PASSWORD) {
  console.warn('WARNUNG: ACCESS_PASSWORD ist in der .env nicht gesetzt, der Passwortschutz lässt aktuell niemanden rein.');
}

// ---------- Zähler dauerhaft auf der Festplatte speichern ----------
// Bewusst eine einfache JSON-Datei statt einer Datenbank, reicht für diesen Zweck
// und übersteht auch einen Neustart des Servers (im Gegensatz zu einer Variable im Speicher).
function readCounter() {
  try {
    const raw = fs.readFileSync(COUNTER_FILE, 'utf8');
    const data = JSON.parse(raw);
    return typeof data.conducted === 'number' ? data.conducted : 0;
  } catch (err) {
    return 0;
  }
}

function incrementCounter() {
  const next = readCounter() + 1;
  fs.mkdirSync(path.dirname(COUNTER_FILE), { recursive: true });
  fs.writeFileSync(COUNTER_FILE, JSON.stringify({ conducted: next }, null, 2));
  return next;
}

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12, // 12 Stunden eingeloggt bleiben
    httpOnly: true,
    sameSite: 'lax'
    // secure: true  // sobald HTTPS über certbot läuft, diese Zeile aktivieren
  }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ status: 'error', message: 'Nicht eingeloggt.' });
  }
  return res.redirect('/login');
}

// ---------- Passwortschutz ----------
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', (req, res) => {
  const submitted = req.body.password || '';
  if (ACCESS_PASSWORD && submitted === ACCESS_PASSWORD) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- Geschützte Testseite ----------
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// ---------- API, ebenfalls nur mit gültiger Sitzung erreichbar ----------
app.get('/api/stats', requireAuth, (req, res) => {
  res.json({ conducted: readCounter() });
});

app.post('/api/start-conversation', requireAuth, async (req, res) => {
  if (!TAVUS_API_KEY) {
    return res.status(500).json({ status: 'error', message: 'TAVUS_API_KEY fehlt in der .env-Datei auf dem Server.' });
  }

  // Solange Persona/Replica noch nicht angelegt sind, bleibt es beim Vorschau-Modus.
  // Passwortschutz, Zähler und das Verstecken des API-Schlüssels funktionieren aber schon vollständig echt,
  // das hier ist der einzige noch offene Platzhalter.
  if (!TAVUS_PERSONA_ID || !TAVUS_REPLICA_ID) {
    const conducted = incrementCounter();
    return res.json({
      status: 'not_configured',
      message: 'AVADIA ist auf diesem Server technisch noch nicht vollständig eingerichtet (Persona/Replica fehlen).',
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
        persona_id: TAVUS_PERSONA_ID,
        replica_id: TAVUS_REPLICA_ID,
        properties: {
          // Feldname bitte gegen die aktuelle Tavus-API-Dokumentation prüfen,
          // Ziel: das Gespräch automatisch nach 12 Minuten beenden.
          max_call_duration: MAX_CALL_DURATION_SECONDS
        }
      })
    });

    const data = await tavusResponse.json();

    if (!tavusResponse.ok) {
      return res.status(502).json({ status: 'error', message: data.message || 'Tavus hat die Anfrage abgelehnt.' });
    }

    const conducted = incrementCounter();
    return res.json({ status: 'ok', conversation_url: data.conversation_url, conducted });

  } catch (err) {
    console.error(err);
    return res.status(502).json({ status: 'error', message: 'Verbindung zu Tavus ist fehlgeschlagen.' });
  }
});

app.listen(PORT, () => {
  console.log('AVADIA-Server läuft auf Port ' + PORT);
});
