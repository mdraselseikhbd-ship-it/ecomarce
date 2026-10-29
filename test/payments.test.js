const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

let server;
let base;
let db;
let outbox;

// Fake SSLCommerz: the validation API answers with whatever is stored for a val_id.
const validations = new Map();
const realFetch = global.fetch;
global.fetch = async (url, options) => {
  const href = String(url);
  if (href.startsWith('https://sandbox.sslcommerz.com/gwprocess/')) {
    const body = new URLSearchParams(options.body);
    return Response.json({ status: 'SUCCESS', GatewayPageURL: `https://sandbox.sslcommerz.com/pay?tran=${body.get('tran_id')}` });
  }
  if (href.startsWith('https://sandbox.sslcommerz.com/validator/')) {
    const valId = new URL(href).searchParams.get('val_id');
    return Response.json(validations.get(valId) || { status: 'INVALID_TRANSACTION' });
  }
  return realFetch(url, options);
};

before(async () => {
  ({ server, base } = await helpers.startServer({ SSLCZ_STORE_ID: 'test', SSLCZ_STORE_PASSWORD: 'test' }));
  ({ db } = require('../src/db'));
  ({ outbox } = require('../src/mailer'));
});

after(() => server.close());

const client = () => helpers.client(base);
const product = (slug) => db.prepare('SELECT id, stock, price FROM products WHERE slug = ?').get(slug);

// Posts a gateway callback the way SSLCommerz does: no cookie, no CSRF token.
function gatewayPost(path, form) {
  return fetch(base + path, { method: 'POST', redirect: 'manual', body: new URLSearchParams(form) });
}

async function placeOnlineOrder(customer, slug, quantity = 1) {
  await customer.post('/cart/add', { productId: product(slug).id, quantity });
  await customer.get('/checkout');
  const res = await customer.post('/checkout', {
    shipping_name: 'Demo', phone: '01711111111', address: 'House 1, Dhaka', payment_method: 'online',
  });
  assert.match(res.location, /^\/payment\/start\/\d+$/);
  const orderId = Number(res.location.split('/').pop());
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

test('online payment: order stays hidden until the gateway confirms it', async () => {
  const customer = client();
  await customer.login('customer@example.com', 'customer123');

  const order = await placeOnlineOrder(customer, 'smart-watch', 2);
  assert.equal(order.payment_status, 'unpaid');
  assert.equal(order.total, 2 * product('smart-watch').price);

  const start = await customer.get(`/payment/start/${order.id}`);
  assert.equal(start.location, `https://sandbox.sslcommerz.com/pay?tran=${order.transaction_id}`);

  const vendor = client();
  await vendor.login('vendor1@example.com', 'vendor123');
  assert.doesNotMatch((await vendor.get('/vendor/orders')).body, /Smart Watch/);

  // A forged callback (wrong amount) is rejected by validation.
  validations.set('forged', { status: 'VALID', tran_id: order.transaction_id, currency_type: 'BDT', currency_amount: '1.00' });
  let res = await gatewayPost('/payment/success', { tran_id: order.transaction_id, val_id: 'forged' });
  assert.equal(res.headers.get('location'), `/account/orders/${order.id}?payment=failed`);
  assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(order.id).payment_status, 'unpaid');

  // Genuine payment.
  validations.set('good', { status: 'VALID', tran_id: order.transaction_id, currency_type: 'BDT', currency_amount: (order.total / 100).toFixed(2) });
  outbox.length = 0;
  res = await gatewayPost('/payment/success', { tran_id: order.transaction_id, val_id: 'good' });
  assert.equal(res.headers.get('location'), `/account/orders/${order.id}?payment=success`);
  assert.equal(res.headers.get('set-cookie'), null, 'callback must not replace the customer session');
  assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(order.id).payment_status, 'paid');

  // IPN for the same payment does not send the confirmation twice.
  await gatewayPost('/payment/ipn', { tran_id: order.transaction_id, val_id: 'good' });
  const subjects = outbox.map((m) => m.subject);
  assert.equal(subjects.filter((s) => s.includes(`Order #${order.id} confirmed`)).length, 1);
  assert.ok(subjects.some((s) => s.includes(`New order #${order.id}`)));

  assert.match((await vendor.get('/vendor/orders')).body, /Smart Watch/);
  assert.match((await customer.get(`/account/orders/${order.id}?payment=success`)).body, /Payment received/);

  // A paid online order can't be self-cancelled (it needs a refund).
  await customer.post(`/account/orders/${order.id}/cancel`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ? AND status = 'cancelled'").get(order.id).n, 0);
});

test('failed payment can be retried, and unpaid orders expire and release stock', async () => {
  const customer = client();
  await customer.login('customer@example.com', 'customer123');
  const before = product('power-bank-20000mah').stock;
  const order = await placeOnlineOrder(customer, 'power-bank-20000mah', 3);
  assert.equal(product('power-bank-20000mah').stock, before - 3);

  const res = await gatewayPost('/payment/fail', { tran_id: order.transaction_id });
  assert.equal(res.headers.get('location'), `/account/orders/${order.id}?payment=failed`);
  const page = await customer.get(`/account/orders/${order.id}?payment=failed`);
  assert.match(page.body, /Pay now/);

  db.prepare("UPDATE orders SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(order.id);
  const { expireUnpaidOrders } = require('../src/routes/payment');
  assert.equal(expireUnpaidOrders(), 1);
  assert.equal(product('power-bank-20000mah').stock, before);
  assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(order.id).payment_status, 'expired');
  assert.equal(expireUnpaidOrders(), 0);
});

test('vendor payouts: balance, requests, admin processing and emails', async () => {
  const customer = client();
  await customer.login('customer@example.com', 'customer123');
  const panjabi = product('cotton-panjabi');
  await customer.post('/cart/add', { productId: panjabi.id, quantity: 2 });
  await customer.get('/checkout');
  const placed = await customer.post('/checkout', { shipping_name: 'Demo', phone: '01711111111', address: 'House 1, Dhaka' });
  const orderId = Number(placed.location.split('/').pop());
  const item = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(orderId);

  const vendor = client();
  await vendor.login('vendor2@example.com', 'vendor123');
  await vendor.get('/vendor/orders');
  outbox.length = 0;
  for (const status of ['processing', 'shipped', 'delivered']) {
    await vendor.post(`/vendor/orders/items/${item.id}/status`, { status });
  }
  assert.equal(outbox.filter((m) => m.subject.includes(`Order #${orderId}`)).length, 3);
  assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(orderId).payment_status, 'paid', 'COD is paid on delivery');

  const { storeBalance } = require('../src/payouts');
  const earned = 2 * panjabi.price - item.commission;
  assert.equal(storeBalance(item.store_id).available, earned);

  await vendor.get('/vendor/payouts');
  await vendor.post('/vendor/payouts', { amount: (earned / 100 + 1).toFixed(2), method: 'bkash', account: '01700000000' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payouts').get().n, 0, 'cannot withdraw more than the balance');

  await vendor.post('/vendor/payouts', { amount: '1000', method: 'bkash', account: '01700000000' });
  assert.equal(storeBalance(item.store_id).available, earned - 1000_00);
  await vendor.post('/vendor/payouts', { amount: (earned / 100).toFixed(2), method: 'nagad', account: '01800000000' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payouts').get().n, 1, 'requested amounts are reserved');

  const payout = db.prepare('SELECT * FROM payouts').get();
  const admin = client();
  await admin.login('admin@example.com', 'admin123');
  assert.match((await admin.get('/admin/payouts')).body, /01700000000/);
  await admin.post(`/admin/payouts/${payout.id}`, { action: 'paid', note: 'TrxID ABC123' });
  assert.equal(db.prepare('SELECT status FROM payouts WHERE id = ?').get(payout.id).status, 'paid');
  assert.ok(outbox.some((m) => m.subject.includes('Payout paid') && m.text.includes('TrxID ABC123')));
  assert.deepEqual(
    { paid: storeBalance(item.store_id).paid, available: storeBalance(item.store_id).available },
    { paid: 1000_00, available: earned - 1000_00 },
  );

  // Processing twice is a no-op.
  await admin.post(`/admin/payouts/${payout.id}`, { action: 'rejected' });
  assert.equal(db.prepare('SELECT status FROM payouts WHERE id = ?').get(payout.id).status, 'paid');
});

test('vendor is emailed when their store is approved', async () => {
  const vendor = client();
  await vendor.get('/register?type=vendor');
  await vendor.post('/register', {
    type: 'vendor', name: 'Mail Seller', email: 'mail@example.com', password: 'secret1', confirm: 'secret1', storeName: 'Mail Store',
  });
  const store = db.prepare("SELECT id FROM stores WHERE slug = 'mail-store'").get();
  outbox.length = 0;
  const admin = client();
  await admin.login('admin@example.com', 'admin123');
  await admin.get('/admin/vendors');
  await admin.post(`/admin/vendors/${store.id}/status`, { status: 'approved' });
  assert.deepEqual(outbox.map((m) => [m.to, m.subject]), [['mail@example.com', '[Bazar] Your store is approved']]);
});
