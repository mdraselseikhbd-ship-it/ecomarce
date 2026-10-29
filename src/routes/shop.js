const express = require('express');
const { db } = require('../db');
const { toInt } = require('../util');
const { flash, requireLogin } = require('../middleware');

const router = express.Router();
const PAGE_SIZE = 12;

// Products are only visible when active and their store is approved.
const VISIBLE = "p.is_active = 1 AND s.status = 'approved'";
const PRODUCT_COLUMNS = `p.*, s.name AS store_name, s.slug AS store_slug, c.name AS category_name,
  (SELECT ROUND(AVG(rating), 1) FROM reviews r WHERE r.product_id = p.id) AS avg_rating,
  (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id) AS review_count`;
const PRODUCT_FROM = `FROM products p
  JOIN stores s ON s.id = p.store_id
  LEFT JOIN categories c ON c.id = p.category_id`;

router.get('/', (req, res) => {
  const latest = db.prepare(`SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE ${VISIBLE} ORDER BY p.created_at DESC, p.id DESC LIMIT 8`).all();
  const bestSellers = db.prepare(`SELECT ${PRODUCT_COLUMNS}, COALESCE(SUM(oi.quantity), 0) AS sold ${PRODUCT_FROM}
    JOIN order_items oi ON oi.product_id = p.id AND oi.status != 'cancelled'
    WHERE ${VISIBLE} GROUP BY p.id ORDER BY sold DESC LIMIT 4`).all();
  const stores = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id AND p.is_active = 1) AS product_count
    FROM stores s WHERE s.status = 'approved' ORDER BY s.created_at DESC LIMIT 6`).all();
  res.render('shop/home', { title: 'Home', latest, bestSellers, stores, categories: allCategories() });
});

function allCategories() {
  return db.prepare('SELECT * FROM categories ORDER BY name').all();
}

function listProducts(req, extraWhere = '', extraParams = []) {
  const q = String(req.query.q || '').trim();
  const category = String(req.query.category || '');
  const sort = String(req.query.sort || 'newest');
  const page = Math.max(1, toInt(req.query.page, 1));

  const where = [VISIBLE];
  const params = [];
  if (extraWhere) { where.push(extraWhere); params.push(...extraParams); }
  if (q) {
    where.push('(p.name LIKE ? OR p.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (category) { where.push('c.slug = ?'); params.push(category); }

  const orderBy = {
    price_asc: 'p.price ASC',
    price_desc: 'p.price DESC',
    rating: 'avg_rating DESC NULLS LAST',
    newest: 'p.created_at DESC, p.id DESC',
  }[sort] || 'p.created_at DESC, p.id DESC';

  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n ${PRODUCT_FROM} WHERE ${whereSql}`).get(...params).n;
  const products = db.prepare(`SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);

  return { products, q, category, sort, page, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total };
}

router.get('/products', (req, res) => {
  res.render('shop/products', { title: 'Products', ...listProducts(req), categories: allCategories(), baseUrl: '/products' });
});

router.get('/product/:slug', (req, res) => {
  const product = db.prepare(`SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE p.slug = ? AND ${VISIBLE}`).get(req.params.slug);
  if (!product) return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });

  const reviews = db.prepare(`SELECT r.*, u.name AS user_name FROM reviews r JOIN users u ON u.id = r.user_id
    WHERE r.product_id = ? ORDER BY r.created_at DESC`).all(product.id);
  const related = db.prepare(`SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM}
    WHERE ${VISIBLE} AND p.id != ? AND (p.category_id = ? OR p.store_id = ?) ORDER BY RANDOM() LIMIT 4`)
    .all(product.id, product.category_id, product.store_id);

  let canReview = false;
  if (req.user && req.user.role === 'customer') {
    canReview = Boolean(db.prepare(`SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.user_id = ? AND oi.product_id = ? AND oi.status = 'delivered' LIMIT 1`).get(req.user.id, product.id));
  }
  res.render('shop/product', { title: product.name, product, reviews, related, canReview });
});

router.post('/product/:slug/review', requireLogin, (req, res) => {
  const product = db.prepare('SELECT id, slug FROM products WHERE slug = ?').get(req.params.slug);
  if (!product) return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });
  const back = `/product/${product.slug}#reviews`;

  const delivered = db.prepare(`SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.user_id = ? AND oi.product_id = ? AND oi.status = 'delivered' LIMIT 1`).get(req.user.id, product.id);
  if (!delivered) {
    flash(req, 'error', 'You can review a product after it has been delivered to you.');
    return res.redirect(back);
  }
  const rating = toInt(req.body.rating);
  if (rating < 1 || rating > 5) {
    flash(req, 'error', 'Please choose a rating between 1 and 5.');
    return res.redirect(back);
  }
  db.prepare(`INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?, ?, ?, ?)
    ON CONFLICT(product_id, user_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, created_at = datetime('now')`)
    .run(product.id, req.user.id, rating, String(req.body.comment || '').trim().slice(0, 2000));
  flash(req, 'success', 'Thanks for your review!');
  res.redirect(back);
});

router.get('/stores', (req, res) => {
  const stores = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id AND p.is_active = 1) AS product_count
    FROM stores s WHERE s.status = 'approved' ORDER BY s.name`).all();
  res.render('shop/stores', { title: 'Stores', stores });
});

router.get('/store/:slug', (req, res) => {
  const shop = db.prepare("SELECT * FROM stores WHERE slug = ? AND status = 'approved'").get(req.params.slug);
  if (!shop) return res.status(404).render('error', { title: 'Not found', message: 'Store not found.' });
  const result = listProducts(req, 'p.store_id = ?', [shop.id]);
  res.render('shop/store', { title: shop.name, shop, ...result, categories: allCategories(), baseUrl: `/store/${shop.slug}` });
});

module.exports = router;
