const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const { slugify, uniqueSlug } = require('../util');
const { flash, requireRole } = require('../middleware');
const { orderStatus } = require('./account');
const mailer = require('../mailer');
const { PAYABLE_ORDER } = require('../payouts');

const router = express.Router();
router.use(requireRole('admin'));

router.get('/', (req, res) => {
  const stats = {
    users: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'").get().n,
    stores: db.prepare("SELECT COUNT(*) AS n FROM stores WHERE status = 'approved'").get().n,
    pendingStores: db.prepare("SELECT COUNT(*) AS n FROM stores WHERE status = 'pending'").get().n,
    products: db.prepare('SELECT COUNT(*) AS n FROM products').get().n,
    orders: db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
    ...db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN oi.status != 'cancelled' THEN oi.unit_price * oi.quantity END), 0) AS gmv,
        COALESCE(SUM(CASE WHEN oi.status = 'delivered' THEN oi.commission END), 0) AS revenue
      FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${PAYABLE_ORDER}`).get(),
    pendingPayouts: db.prepare("SELECT COUNT(*) AS n FROM payouts WHERE status = 'requested'").get().n,
  };
  const topStores = db.prepare(`SELECT s.name, s.slug, COALESCE(SUM(oi.unit_price * oi.quantity), 0) AS sales
    FROM stores s LEFT JOIN order_items oi ON oi.store_id = s.id AND oi.status != 'cancelled'
      AND oi.order_id IN (SELECT o.id FROM orders o WHERE ${PAYABLE_ORDER})
    GROUP BY s.id ORDER BY sales DESC LIMIT 5`).all();
  res.render('admin/dashboard', { title: 'Admin dashboard', stats, topStores });
});

router.get('/vendors', (req, res) => {
  const vendors = db.prepare(`SELECT s.*, u.name AS owner_name, u.email AS owner_email,
      (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS product_count
    FROM stores s JOIN users u ON u.id = s.user_id
    ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END, s.created_at DESC`).all();
  res.render('admin/vendors', { title: 'Vendors', vendors });
});

router.post('/vendors/:id/status', (req, res) => {
  const status = String(req.body.status || '');
  if (!['pending', 'approved', 'suspended'].includes(status)) {
    flash(req, 'error', 'Invalid status.');
    return res.redirect('/admin/vendors');
  }
  const result = db.prepare('UPDATE stores SET status = ? WHERE id = ? AND status != ?').run(status, req.params.id, status);
  if (result.changes) mailer.storeStatusChanged(Number(req.params.id));
  flash(req, result.changes ? 'success' : 'error', result.changes ? `Store ${status}.` : 'Store not found or already in that state.');
  res.redirect('/admin/vendors');
});

router.get('/categories', (req, res) => {
  const categories = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
    FROM categories c ORDER BY c.name`).all();
  res.render('admin/categories', { title: 'Categories', categories });
});

router.post('/categories', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) {
    flash(req, 'error', 'Category name is required.');
  } else {
    db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').run(name, uniqueSlug(db, 'categories', slugify(name)));
    flash(req, 'success', 'Category added.');
  }
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  flash(req, 'success', 'Category deleted. Its products are now uncategorised.');
  res.redirect('/admin/categories');
});

router.get('/products', (req, res) => {
  const products = db.prepare(`SELECT p.*, s.name AS store_name, c.name AS category_name
    FROM products p JOIN stores s ON s.id = p.store_id LEFT JOIN categories c ON c.id = p.category_id
    ORDER BY p.id DESC`).all();
  res.render('admin/products', { title: 'All products', products });
});

router.post('/products/:id/toggle', (req, res) => {
  db.prepare('UPDATE products SET is_active = 1 - is_active WHERE id = ?').run(req.params.id);
  flash(req, 'success', 'Product visibility changed.');
  res.redirect('/admin/products');
});

router.get('/orders', (req, res) => {
  const orders = db.prepare(`SELECT o.*, u.name AS customer_name, u.email AS customer_email,
      (SELECT COUNT(DISTINCT store_id) FROM order_items oi WHERE oi.order_id = o.id) AS vendor_count
    FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC`).all();
  const itemsStmt = db.prepare(`SELECT oi.*, s.name AS store_name FROM order_items oi JOIN stores s ON s.id = oi.store_id
    WHERE oi.order_id = ?`);
  for (const order of orders) {
    order.items = itemsStmt.all(order.id);
    order.status = orderStatus(order.items);
  }
  res.render('admin/orders', { title: 'All orders', orders });
});

router.get('/payouts', (req, res) => {
  const payouts = db.prepare(`SELECT p.*, s.name AS store_name FROM payouts p JOIN stores s ON s.id = p.store_id
    ORDER BY CASE p.status WHEN 'requested' THEN 0 ELSE 1 END, p.id DESC`).all();
  res.render('admin/payouts', { title: 'Payouts', payouts });
});

router.post('/payouts/:id', (req, res) => {
  const status = req.body.action === 'paid' ? 'paid' : req.body.action === 'rejected' ? 'rejected' : null;
  if (!status) return res.redirect('/admin/payouts');
  const result = db.prepare(`UPDATE payouts SET status = ?, note = ?, processed_at = datetime('now')
    WHERE id = ? AND status = 'requested'`).run(status, String(req.body.note || '').trim().slice(0, 500), req.params.id);
  if (result.changes) mailer.payoutProcessed(Number(req.params.id));
  flash(req, result.changes ? 'success' : 'error', result.changes ? `Payout marked ${status}.` : 'This payout was already processed.');
  res.redirect('/admin/payouts');
});

router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY id DESC').all();
  res.render('admin/users', { title: 'Users', users });
});

router.get('/settings', (req, res) => {
  res.render('admin/settings', { title: 'Marketplace settings', commission: getSetting('commission_percent') });
});

router.post('/settings', (req, res) => {
  const commission = Number(req.body.commission_percent);
  if (!Number.isFinite(commission) || commission < 0 || commission > 100) {
    flash(req, 'error', 'Commission must be between 0 and 100.');
  } else {
    setSetting('commission_percent', commission);
    flash(req, 'success', 'Settings saved. New commission applies to future orders.');
  }
  res.redirect('/admin/settings');
});

module.exports = router;
