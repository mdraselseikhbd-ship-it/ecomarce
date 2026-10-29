const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

let server;
let base;
let db;

before(async () => {
  ({ server, base } = await helpers.startServer());
  ({ db } = require('../src/db'));
});

after(() => server.close());

const client = () => helpers.client(base);

const productId = (slug) => db.prepare('SELECT id, stock FROM products WHERE slug = ?').get(slug);

test('public pages render', async () => {
  const c = client();
  for (const path of ['/', '/products', '/stores', '/store/rahim-electronics', '/product/jamdani-saree']) {
    assert.equal((await c.get(path)).status, 200, path);
  }
  assert.match((await c.get('/products?q=earbuds')).body, /Wireless Earbuds/);
});

test('POST without CSRF token is rejected', async () => {
  const res = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=admin@example.com&password=admin123',
  });
  assert.equal(res.status, 403);
});

test('customer buys from two vendors, vendors fulfil, customer reviews', async () => {
  const earbuds = productId('wireless-earbuds');
  const saree = productId('jamdani-saree');

  const customer = client();
  await customer.login('customer@example.com', 'customer123');
  await customer.get('/products');
  await customer.post('/cart/add', { productId: earbuds.id, quantity: 2 });
  await customer.post('/cart/add', { productId: saree.id, quantity: 1 });
  const cart = await customer.get('/cart');
  assert.match(cart.body, /Rahim Electronics/);
  assert.match(cart.body, /Deshi Fashion House/);

  const bad = await customer.post('/checkout', { shipping_name: 'Demo', phone: 'x', address: '' });
  assert.equal(bad.status, 422);

  const placed = await customer.post('/checkout', { shipping_name: 'Demo', phone: '01711111111', address: 'House 1, Road 2, Dhaka' });
  assert.equal(placed.status, 302);
  const orderId = Number(placed.location.split('/').pop());

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  assert.equal(order.total, 2 * 1850_00 + 6500_00);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
  assert.equal(items.length, 2);
  assert.notEqual(items[0].store_id, items[1].store_id);
  assert.equal(items[0].commission, Math.round(2 * 1850_00 * 0.10));
  assert.equal(productId('wireless-earbuds').stock, earbuds.stock - 2);

  // Vendor 1 can only see and update their own line item.
  const vendor = client();
  await vendor.login('vendor1@example.com', 'vendor123');
  const vendorOrders = await vendor.get('/vendor/orders');
  assert.match(vendorOrders.body, /Wireless Earbuds/);
  assert.doesNotMatch(vendorOrders.body, /Jamdani Saree/);
  const otherItem = items.find((i) => i.product_id === saree.id);
  assert.equal((await vendor.post(`/vendor/orders/items/${otherItem.id}/status`, { status: 'processing' })).status, 404);

  const ownItem = items.find((i) => i.product_id === earbuds.id);
  // Skipping steps is not allowed.
  await vendor.post(`/vendor/orders/items/${ownItem.id}/status`, { status: 'delivered' });
  assert.equal(db.prepare('SELECT status FROM order_items WHERE id = ?').get(ownItem.id).status, 'pending');
  for (const status of ['processing', 'shipped', 'delivered']) {
    await vendor.post(`/vendor/orders/items/${ownItem.id}/status`, { status });
  }
  assert.equal(db.prepare('SELECT status FROM order_items WHERE id = ?').get(ownItem.id).status, 'delivered');

  // Customer cancels the remaining pending item; stock is restored.
  await customer.get(`/account/orders/${orderId}`);
  await customer.post(`/account/orders/${orderId}/cancel`);
  assert.equal(db.prepare('SELECT status FROM order_items WHERE id = ?').get(otherItem.id).status, 'cancelled');
  assert.equal(productId('jamdani-saree').stock, saree.stock);

  // Review is allowed for the delivered product only.
  await customer.get('/product/wireless-earbuds');
  await customer.post('/product/wireless-earbuds/review', { rating: 5, comment: 'Great sound' });
  await customer.post('/product/jamdani-saree/review', { rating: 1, comment: 'nope' });
  const reviews = db.prepare('SELECT product_id FROM reviews').all();
  assert.deepEqual(reviews.map((r) => r.product_id), [earbuds.id]);
  assert.match((await customer.get('/product/wireless-earbuds')).body, /Great sound/);
});

test('new vendor is hidden until admin approves the store', async () => {
  const vendor = client();
  await vendor.get('/register?type=vendor');
  const reg = await vendor.post('/register', {
    type: 'vendor', name: 'New Seller', email: 'new@example.com', password: 'secret1', confirm: 'secret1', storeName: 'Fresh Mart',
  });
  assert.equal(reg.location, '/vendor');
  assert.equal((await vendor.get('/vendor')).status, 200);

  const store = db.prepare("SELECT * FROM stores WHERE slug = 'fresh-mart'").get();
  assert.equal(store.status, 'pending');
  assert.equal((await client().get('/store/fresh-mart')).status, 404);

  // Customers cannot reach the vendor or admin panels.
  const customer = client();
  await customer.login('customer@example.com', 'customer123');
  assert.equal((await customer.get('/admin')).status, 403);
  assert.equal((await customer.get('/vendor')).status, 403);

  const admin = client();
  await admin.login('admin@example.com', 'admin123');
  await admin.get('/admin/vendors');
  await admin.post(`/admin/vendors/${store.id}/status`, { status: 'approved' });
  assert.equal((await client().get('/store/fresh-mart')).status, 200);
});

test('vendor can add a product with a multipart form', async () => {
  const vendor = client();
  await vendor.login('vendor2@example.com', 'vendor123');
  const page = await vendor.get('/vendor/products/new');
  const action = page.body.match(/action="(\/vendor\/products\/new\?_csrf=[a-f0-9]+)"/)[1];

  const form = new FormData();
  form.set('name', 'Handloom Gamcha');
  form.set('price', '250.75');
  form.set('stock', '20');
  form.set('is_active', '1');
  form.set('image', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'g.png');
  const res = await vendor.postMultipart(action, form);
  assert.equal(res.status, 302);
  const product = db.prepare("SELECT * FROM products WHERE name = 'Handloom Gamcha'").get();
  assert.equal(product.price, 25075);
  assert.match(product.image, /^\/uploads\/[a-f0-9]+\.png$/);
  require('node:fs').rmSync(require('node:path').join(__dirname, '..', product.image), { force: true });
});
