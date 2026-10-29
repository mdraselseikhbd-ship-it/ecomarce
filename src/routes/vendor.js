const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { db, transaction } = require('../db');
const { uniqueSlug, toPaisa, toInt } = require('../util');
const { flash, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireRole('vendor'));

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const ALLOWED_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + ALLOWED_TYPES[file.mimetype]),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, Boolean(ALLOWED_TYPES[file.mimetype])),
});

function uploadImage(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) {
      flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'Image must be smaller than 2 MB.' : 'Image upload failed.');
      return res.redirect(req.originalUrl.split('?')[0]);
    }
    next();
  });
}

function removeImage(image) {
  if (image && image.startsWith('/uploads/')) {
    fs.rm(path.join(UPLOAD_DIR, path.basename(image)), { force: true }, () => {});
  }
}

router.use((req, res, next) => {
  if (!req.store) return res.status(403).render('error', { title: 'No store', message: 'No store is linked to this account.' });
  next();
});

function findOwnProduct(req) {
  return db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(req.params.id, req.store.id);
}

router.get('/', (req, res) => {
  const storeId = req.store.id;
  const stats = db.prepare(`SELECT
      COUNT(DISTINCT oi.order_id) AS orders,
      COALESCE(SUM(CASE WHEN oi.status != 'cancelled' THEN oi.unit_price * oi.quantity END), 0) AS gross,
      COALESCE(SUM(CASE WHEN oi.status != 'cancelled' THEN oi.commission END), 0) AS commission,
      COALESCE(SUM(CASE WHEN oi.status = 'delivered' THEN oi.unit_price * oi.quantity - oi.commission END), 0) AS earned,
      COALESCE(SUM(CASE WHEN oi.status = 'pending' THEN 1 END), 0) AS pending
    FROM order_items oi WHERE oi.store_id = ?`).get(storeId);
  stats.products = db.prepare('SELECT COUNT(*) AS n FROM products WHERE store_id = ?').get(storeId).n;
  stats.lowStock = db.prepare('SELECT COUNT(*) AS n FROM products WHERE store_id = ? AND stock <= 5').get(storeId).n;
  const recent = db.prepare(`SELECT oi.*, o.shipping_name, o.created_at FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.store_id = ? ORDER BY oi.id DESC LIMIT 8`).all(storeId);
  res.render('vendor/dashboard', { title: 'Seller dashboard', stats, recent });
});

router.get('/products', (req, res) => {
  const products = db.prepare(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.store_id = ? ORDER BY p.id DESC`).all(req.store.id);
  res.render('vendor/products', { title: 'My products', products });
});

function productForm(req) {
  return {
    name: String(req.body.name || '').trim(),
    description: String(req.body.description || '').trim(),
    price: req.body.price,
    stock: req.body.stock,
    category_id: toInt(req.body.category_id) || null,
    is_active: req.body.is_active ? 1 : 0,
  };
}

function validateProduct(form) {
  const errors = [];
  if (!form.name) errors.push('Product name is required.');
  if (toPaisa(form.price) === null) errors.push('Price must be a positive number.');
  if (toInt(form.stock, -1) < 0) errors.push('Stock must be 0 or more.');
  return errors;
}

function renderForm(res, product, errors, status = 200) {
  const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
  res.status(status).render('vendor/product-form', { title: product.id ? 'Edit product' : 'Add product', product, categories, errors });
}

router.get('/products/new', (req, res) => {
  renderForm(res, { is_active: 1, stock: 1 }, []);
});

router.post('/products/new', uploadImage, (req, res) => {
  const form = productForm(req);
  const errors = validateProduct(form);
  if (errors.length) {
    if (req.file) removeImage('/uploads/' + req.file.filename);
    return renderForm(res, form, errors, 422);
  }
  db.prepare(`INSERT INTO products (store_id, category_id, name, slug, description, price, stock, image, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.store.id, form.category_id, form.name, uniqueSlug(db, 'products', form.name), form.description,
    toPaisa(form.price), toInt(form.stock), req.file ? '/uploads/' + req.file.filename : null, form.is_active,
  );
  flash(req, 'success', 'Product added.');
  res.redirect('/vendor/products');
});

router.get('/products/:id/edit', (req, res) => {
  const product = findOwnProduct(req);
  if (!product) return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });
  renderForm(res, { ...product, price: (product.price / 100).toFixed(2) }, []);
});

router.post('/products/:id/edit', uploadImage, (req, res) => {
  const product = findOwnProduct(req);
  if (!product) return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });
  const form = productForm(req);
  const errors = validateProduct(form);
  if (errors.length) {
    if (req.file) removeImage('/uploads/' + req.file.filename);
    return renderForm(res, { ...form, id: product.id, image: product.image }, errors, 422);
  }
  let image = product.image;
  if (req.file) {
    removeImage(product.image);
    image = '/uploads/' + req.file.filename;
  } else if (req.body.remove_image) {
    removeImage(product.image);
    image = null;
  }
  const slug = form.name === product.name ? product.slug : uniqueSlug(db, 'products', form.name, product.id);
  db.prepare(`UPDATE products SET category_id = ?, name = ?, slug = ?, description = ?, price = ?, stock = ?, image = ?, is_active = ?
    WHERE id = ?`).run(form.category_id, form.name, slug, form.description, toPaisa(form.price), toInt(form.stock), image, form.is_active, product.id);
  flash(req, 'success', 'Product updated.');
  res.redirect('/vendor/products');
});

router.post('/products/:id/delete', (req, res) => {
  const product = findOwnProduct(req);
  if (!product) return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });
  db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
  removeImage(product.image);
  flash(req, 'success', 'Product deleted.');
  res.redirect('/vendor/products');
});

router.get('/orders', (req, res) => {
  const status = String(req.query.status || '');
  const params = [req.store.id];
  let filter = '';
  if (status) { filter = 'AND oi.status = ?'; params.push(status); }
  const items = db.prepare(`SELECT oi.*, o.shipping_name, o.phone, o.address, o.payment_method, o.created_at
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.store_id = ? ${filter} ORDER BY oi.id DESC`).all(...params);
  res.render('vendor/orders', { title: 'Orders', items, status });
});

// Allowed forward transitions for a vendor's line item.
const TRANSITIONS = {
  pending: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

router.post('/orders/items/:id/status', (req, res) => {
  const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND store_id = ?').get(req.params.id, req.store.id);
  if (!item) return res.status(404).render('error', { title: 'Not found', message: 'Order item not found.' });
  const next = String(req.body.status || '');
  if (!TRANSITIONS[item.status].includes(next)) {
    flash(req, 'error', `Cannot change status from ${item.status} to ${next}.`);
    return res.redirect('/vendor/orders');
  }
  transaction(() => {
    db.prepare('UPDATE order_items SET status = ? WHERE id = ?').run(next, item.id);
    if (next === 'cancelled' && item.product_id) {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
    }
  });
  flash(req, 'success', `Order #${item.order_id} item marked as ${next}.`);
  res.redirect('/vendor/orders' + (req.body.filter ? `?status=${encodeURIComponent(req.body.filter)}` : ''));
});

router.get('/settings', (req, res) => {
  res.render('vendor/settings', { title: 'Store settings' });
});

router.post('/settings', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) {
    flash(req, 'error', 'Store name is required.');
    return res.redirect('/vendor/settings');
  }
  const slug = name === req.store.name ? req.store.slug : uniqueSlug(db, 'stores', name, req.store.id);
  db.prepare('UPDATE stores SET name = ?, slug = ?, description = ?, phone = ? WHERE id = ?')
    .run(name, slug, String(req.body.description || '').trim(), String(req.body.phone || '').trim(), req.store.id);
  flash(req, 'success', 'Store updated.');
  res.redirect('/vendor/settings');
});

module.exports = router;
module.exports.TRANSITIONS = TRANSITIONS;
