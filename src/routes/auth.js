const express = require('express');
const { db, transaction } = require('../db');
const { hashPassword, verifyPassword, uniqueSlug } = require('../util');
const { flash } = require('../middleware');

const router = express.Router();

// Only allow redirects back to local paths.
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function homeFor(user) {
  if (user.role === 'admin') return '/admin';
  if (user.role === 'vendor') return '/vendor';
  return '/';
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/login', { title: 'Login', next: req.query.next || '', email: '' });
});

router.post('/login', (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    res.locals.flash = [{ type: 'error', message: 'Wrong email or password.' }];
    return res.status(401).render('auth/login', { title: 'Login', next: req.body.next || '', email });
  }
  const cart = req.session.cart;
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    if (cart) req.session.cart = cart;
    flash(req, 'success', `Welcome back, ${user.name}!`);
    res.redirect(req.body.next ? safeNext(req.body.next) : homeFor(user));
  });
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  const type = req.query.type === 'vendor' ? 'vendor' : 'customer';
  res.render('auth/register', { title: type === 'vendor' ? 'Become a seller' : 'Create account', type, form: {}, errors: [] });
});

router.post('/register', (req, res, next) => {
  const type = req.body.type === 'vendor' ? 'vendor' : 'customer';
  const form = {
    name: String(req.body.name || '').trim(),
    email: String(req.body.email || '').trim().toLowerCase(),
    storeName: String(req.body.storeName || '').trim(),
    storeDescription: String(req.body.storeDescription || '').trim(),
    phone: String(req.body.phone || '').trim(),
  };
  const password = String(req.body.password || '');
  const errors = [];
  if (!form.name) errors.push('Name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.push('A valid email is required.');
  if (password.length < 6) errors.push('Password must be at least 6 characters.');
  if (password !== req.body.confirm) errors.push('Passwords do not match.');
  if (type === 'vendor' && !form.storeName) errors.push('Store name is required.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(form.email)) errors.push('This email is already registered.');

  if (errors.length) {
    return res.status(422).render('auth/register', { title: 'Register', type, form, errors });
  }

  const userId = transaction(() => {
    const id = Number(db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(form.name, form.email, hashPassword(password), type).lastInsertRowid);
    if (type === 'vendor') {
      db.prepare('INSERT INTO stores (user_id, name, slug, description, phone) VALUES (?, ?, ?, ?, ?)')
        .run(id, form.storeName, uniqueSlug(db, 'stores', form.storeName), form.storeDescription, form.phone);
    }
    return id;
  });

  const cart = req.session.cart;
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = userId;
    if (cart) req.session.cart = cart;
    if (type === 'vendor') {
      flash(req, 'success', 'Your store has been created and is waiting for admin approval. You can add products meanwhile.');
      return res.redirect('/vendor');
    }
    flash(req, 'success', 'Account created. Happy shopping!');
    res.redirect('/');
  });
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

module.exports = router;
