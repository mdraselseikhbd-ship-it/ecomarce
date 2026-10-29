const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function slugify(text) {
  const base = String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9ঀ-৿]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'item';
}

// Returns a slug that is not yet used in `table`, appending -2, -3, ... when needed.
function uniqueSlug(db, table, text, ignoreId = null) {
  const base = slugify(text);
  let slug = base;
  for (let i = 2; ; i++) {
    const row = db.prepare(`SELECT id FROM ${table} WHERE slug = ?`).get(slug);
    if (!row || row.id === ignoreId) return slug;
    slug = `${base}-${i}`;
  }
}

// "123.45" -> 12345 paisa. Returns null for invalid input.
function toPaisa(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function formatMoney(paisa) {
  const taka = (Number(paisa) || 0) / 100;
  return '৳' + taka.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function toInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { hashPassword, verifyPassword, slugify, uniqueSlug, toPaisa, formatMoney, toInt };
