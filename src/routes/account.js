const express = require('express');
const { db, transaction } = require('../db');
const { hashPassword, verifyPassword } = require('../util');
const { flash, requireLogin } = require('../middleware');

const router = express.Router();
router.use(requireLogin);

// The overall status of an order is derived from its vendor line items.
function orderStatus(items) {
  const statuses = new Set(items.map((i) => i.status));
  if (statuses.size === 1) return items[0].status;
  if (statuses.size === 2 && statuses.has('cancelled')) return [...statuses].find((s) => s !== 'cancelled');
  return 'processing';
}

router.get('/', (req, res) => res.redirect('/account/orders'));

router.get('/orders', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  const itemsStmt = db.prepare('SELECT status FROM order_items WHERE order_id = ?');
  for (const order of orders) order.status = orderStatus(itemsStmt.all(order.id));
  res.render('account/orders', { title: 'My orders', orders });
});

router.get('/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!order) return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
  const items = db.prepare(`SELECT oi.*, s.name AS store_name, s.slug AS store_slug, p.slug AS product_slug
    FROM order_items oi JOIN stores s ON s.id = oi.store_id LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ? ORDER BY s.name, oi.id`).all(order.id);
  order.status = orderStatus(items);
  res.render('account/order', { title: `Order #${order.id}`, order, items });
});

// Customers may cancel the line items that vendors have not started processing yet.
router.post('/orders/:id/cancel', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!order) return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
  const cancelled = transaction(() => {
    const pending = db.prepare("SELECT id, product_id, quantity FROM order_items WHERE order_id = ? AND status = 'pending'").all(order.id);
    for (const item of pending) {
      db.prepare("UPDATE order_items SET status = 'cancelled' WHERE id = ?").run(item.id);
      if (item.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
    }
    return pending.length;
  });
  flash(req, cancelled ? 'success' : 'error', cancelled ? 'Pending items were cancelled.' : 'Nothing could be cancelled; vendors already started processing.');
  res.redirect(`/account/orders/${order.id}`);
});

router.get('/profile', (req, res) => {
  res.render('account/profile', { title: 'Profile' });
});

router.post('/profile', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) {
    flash(req, 'error', 'Name is required.');
    return res.redirect('/account/profile');
  }
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);

  if (req.body.new_password) {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body.current_password || ''), row.password_hash)) {
      flash(req, 'error', 'Current password is incorrect.');
      return res.redirect('/account/profile');
    }
    if (String(req.body.new_password).length < 6) {
      flash(req, 'error', 'New password must be at least 6 characters.');
      return res.redirect('/account/profile');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(req.body.new_password)), req.user.id);
  }
  flash(req, 'success', 'Profile updated.');
  res.redirect('/account/profile');
});

module.exports = router;
module.exports.orderStatus = orderStatus;
