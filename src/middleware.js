const crypto = require('node:crypto');
const { db } = require('./db');

// Loads the logged-in user (and their store, for vendors) into res.locals.
function loadUser(req, res, next) {
  res.locals.user = null;
  res.locals.store = null;
  if (req.session.userId) {
    const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      req.user = user;
      res.locals.user = user;
      if (user.role === 'vendor') {
        req.store = db.prepare('SELECT * FROM stores WHERE user_id = ?').get(user.id) || null;
        res.locals.store = req.store;
      }
    } else {
      delete req.session.userId;
    }
  }
  const cart = req.session.cart || {};
  res.locals.cartCount = Object.values(cart).reduce((sum, qty) => sum + qty, 0);
  next();
}

function flash(req, type, message) {
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ type, message });
}

function exposeFlash(req, res, next) {
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  next();
}

// Synchronizer-token CSRF protection. The token may come from the form body or,
// for multipart forms (parsed later by multer), from the query string.
function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = (req.body && req.body._csrf) || req.query._csrf || req.get('x-csrf-token');
  const expected = Buffer.from(req.session.csrfToken);
  const actual = Buffer.from(String(token || ''));
  if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) return next();
  res.status(403).render('error', { title: 'Forbidden', message: 'Invalid or expired form. Please go back and try again.' });
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  flash(req, 'error', 'Please log in first.');
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return requireLogin(req, res, next);
    if (req.user.role !== role) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'You do not have access to this page.' });
    }
    next();
  };
}

module.exports = { loadUser, flash, exposeFlash, csrf, requireLogin, requireRole };
