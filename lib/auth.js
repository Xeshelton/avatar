// Passwortschutz ohne Server-Speicher (wichtig für Vercel, da jede Anfrage auf
// einer neuen, "leeren" Instanz landen kann). Die Sitzung steckt komplett,
// aber signiert und fälschungssicher, im Cookie selbst.
const crypto = require('crypto');

const COOKIE_NAME = 'avadia_auth';
const SESSION_LENGTH_MS = 1000 * 60 * 60 * 12; // 12 Stunden eingeloggt bleiben

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function createAuthCookieValue(secret) {
  const expiresAt = Date.now() + SESSION_LENGTH_MS;
  const payload = String(expiresAt);
  const signature = sign(payload, secret);
  return `${payload}.${signature}`;
}

function isValidAuthCookie(cookieValue, secret) {
  if (!cookieValue) return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;

  const expected = sign(payload, secret);
  const validSignature =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

  if (!validSignature) return false;

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

module.exports = { COOKIE_NAME, createAuthCookieValue, isValidAuthCookie };
