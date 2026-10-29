const express = require('express');
const { db, transaction, getSetting } = require('../db');
const { toInt } = require('../util');
const { flash, requireLogin } = require('../middleware');
const crypto = require('node:crypto');
const payment = require('../payment');
const mailer = require('../mailer');

const router = express.Router();

// Resolves the session cart ({ productId: qty }) into product rows grouped by store.
// Items that are no longer purchasable are dropped from the cart.
function loadCart(req) {
  const cart = req.session.cart || {};
  const ids = Object.keys(cart).map(Number).filter(Boolean);
  if (!ids.length) return { groups: [], items: [], total: 0 };

  const rows = db.prepare(`SELECT p.id, p.name, p.slug, p.price, p.stock, p.image, p.store_id, s.name AS store_name, s.slug AS store_slug
    FROM products p JOIN stores s ON s.id = p.store_id
    WHERE p.id IN (${ids.map(() => '?').join(',')}) AND p.is_active = 1 AND s.status = 'approved'`).all(...ids);

  const items = [];
  for (const row of rows) {
    const quantity = Math.min(cart[row.id], row.stock);
    if (quantity > 0) items.push({ ...row, quantity, subtotal: row.price * quantity });
  }
  req.session.cart = Object.fromEntries(items.map((i) => [i.id, i.quantity]));

  const byStore = new Map();
  for (const item of items) {
    if (!byStore.has(item.store_id)) {
      byStore.set(item.store_id, { store_id: item.store_id, store_name: item.store_name, store_slug: item.store_slug, items: [], subtotal: 0 });
    }
    const group = byStore.get(item.store_id);
    group.items.push(item);
    group.subtotal += item.subtotal;
  }
  return { groups: [...byStore.values()], items, total: items.reduce((sum, i) => sum + i.subtotal, 0) };
}

router.get('/cart', (req, res) => {
  res.render('shop/cart', { title: 'Cart', ...loadCart(req) });
});

router.post('/cart/add', (req, res) => {
  const productId = toInt(req.body.productId);
  const qty = Math.max(1, toInt(req.body.quantity, 1));
  const product = db.prepare(`SELECT p.id, p.name, p.stock, p.slug FROM products p JOIN stores s ON s.id = p.store_id
    WHERE p.id = ? AND p.is_active = 1 AND s.status = 'approved'`).get(productId);
  if (!product) {
    flash(req, 'error', 'This product is not available.');
    return res.redirect('/products');
  }
  if (req.user && req.user.role !== 'customer') {
    flash(req, 'error', 'Only customer accounts can place orders.');
    return res.redirect(`/product/${product.slug}`);
  }
  const cart = req.session.cart || {};
  const newQty = Math.min((cart[product.id] || 0) + qty, product.stock);
  if (newQty <= 0) {
    flash(req, 'error', 'Sorry, this product is out of stock.');
  } else {
    cart[product.id] = newQty;
    req.session.cart = cart;
    flash(req, 'success', `${product.name} added to cart.`);
  }
  res.redirect(req.body.redirect === 'cart' ? '/cart' : `/product/${product.slug}`);
});

router.post('/cart/update', (req, res) => {
  const cart = req.session.cart || {};
  const productId = toInt(req.body.productId);
  const qty = toInt(req.body.quantity, 0);
  if (qty > 0) cart[productId] = qty;
  else delete cart[productId];
  req.session.cart = cart;
  res.redirect('/cart');
});

router.get('/checkout', requireLogin, (req, res) => {
  if (req.user.role !== 'customer') {
    flash(req, 'error', 'Only customer accounts can place orders.');
    return res.redirect('/cart');
  }
  const cart = loadCart(req);
  if (!cart.items.length) return res.redirect('/cart');
  res.render('shop/checkout', { title: 'Checkout', ...cart, form: { shipping_name: req.user.name }, errors: [], onlinePayment: payment.isEnabled() });
});

router.post('/checkout', requireLogin, (req, res) => {
  if (req.user.role !== 'customer') return res.redirect('/cart');
  const cart = loadCart(req);
  if (!cart.items.length) return res.redirect('/cart');

  const form = {
    shipping_name: String(req.body.shipping_name || '').trim(),
    phone: String(req.body.phone || '').trim(),
    address: String(req.body.address || '').trim(),
    payment_method: req.body.payment_method === 'online' && payment.isEnabled() ? 'online' : 'cod',
  };
  const errors = [];
  if (!form.shipping_name) errors.push('Name is required.');
  if (!/^\+?[0-9\s-]{8,15}$/.test(form.phone)) errors.push('A valid phone number is required.');
  if (form.address.length < 5) errors.push('Full delivery address is required.');
  if (errors.length) {
    return res.status(422).render('shop/checkout', { title: 'Checkout', ...cart, form, errors, onlinePayment: payment.isEnabled() });
  }

  const commissionPercent = Number(getSetting('commission_percent')) || 0;
  let orderId;
  try {
    orderId = transaction(() => {
      // Re-check stock inside the transaction and decrement atomically.
      const decrement = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
      for (const item of cart.items) {
        if (decrement.run(item.quantity, item.id, item.quantity).changes !== 1) {
          throw Object.assign(new Error(`Not enough stock for ${item.name}.`), { stock: true });
        }
      }
      const transactionId = form.payment_method === 'online' ? `BZR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}` : null;
      const id = Number(db.prepare(`INSERT INTO orders (user_id, total, shipping_name, phone, address, payment_method, transaction_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(req.user.id, cart.total, form.shipping_name, form.phone, form.address, form.payment_method, transactionId).lastInsertRowid);
      const insertItem = db.prepare(`INSERT INTO order_items (order_id, product_id, store_id, product_name, unit_price, quantity, commission)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const item of cart.items) {
        const commission = Math.round(item.subtotal * commissionPercent / 100);
        insertItem.run(id, item.id, item.store_id, item.name, item.price, item.quantity, commission);
      }
      return id;
    });
  } catch (err) {
    if (!err.stock) throw err;
    flash(req, 'error', err.message);
    return res.redirect('/cart');
  }

  req.session.cart = {};
  if (form.payment_method === 'online') return res.redirect(`/payment/start/${orderId}`);
  mailer.orderPlaced(orderId);
  flash(req, 'success', `Order #${orderId} placed successfully!`);
  res.redirect(`/account/orders/${orderId}`);
});

module.exports = router;
module.exports.loadCart = loadCart;
