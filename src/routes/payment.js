const express = require('express');
const { db, transaction } = require('../db');
const payment = require('../payment');
const mailer = require('../mailer');
const { flash, requireLogin } = require('../middleware');

const router = express.Router();
// Gateway callbacks are mounted before the session middleware: they arrive as
// cross-site POSTs without the customer's cookie, and creating a session there
// would overwrite (log out) the customer's real one.
const callbacks = express.Router();

const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

// Sends the customer to the gateway. Also used to retry a failed payment.
router.get('/payment/start/:id', requireLogin, async (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ? AND payment_method = 'online'").get(req.params.id, req.user.id);
  if (!order) return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
  const back = `/account/orders/${order.id}`;
  const open = db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ? AND status != 'cancelled'").get(order.id).n;
  if (order.payment_status === 'paid' || !open) return res.redirect(back);
  if (!payment.isEnabled()) {
    flash(req, 'error', 'Online payment is not available right now.');
    return res.redirect(back);
  }
  try {
    const url = await payment.createSession({ order, customer: req.user, itemCount: open, baseUrl: baseUrl(req) });
    res.redirect(url);
  } catch (err) {
    console.error(err);
    flash(req, 'error', 'Could not reach the payment gateway. Please try again.');
    res.redirect(back);
  }
});

function findByTransaction(tranId) {
  return tranId ? db.prepare('SELECT * FROM orders WHERE transaction_id = ?').get(String(tranId)) : null;
}

// Confirms a payment with the gateway and marks the order paid (once).
async function confirmPayment(body) {
  const order = findByTransaction(body.tran_id);
  if (!order) return null;
  if (order.payment_status === 'paid') return order;
  if (!body.val_id) return order;
  const validation = await payment.validate(String(body.val_id));
  if (!payment.isValidPayment(validation, order)) return order;
  const changed = db.prepare("UPDATE orders SET payment_status = 'paid' WHERE id = ? AND payment_status != 'paid'").run(order.id).changes;
  if (changed) mailer.orderPlaced(order.id);
  return { ...order, payment_status: 'paid' };
}

// Nothing posted here is trusted until the gateway validates it server-to-server.
callbacks.post('/payment/success', async (req, res) => {
  const order = await confirmPayment(req.body);
  if (!order) return res.redirect('/account/orders');
  res.redirect(`/account/orders/${order.id}?payment=${order.payment_status === 'paid' ? 'success' : 'failed'}`);
});

callbacks.post('/payment/ipn', async (req, res) => {
  await confirmPayment(req.body);
  res.send('OK');
});

for (const outcome of ['fail', 'cancel']) {
  callbacks.post(`/payment/${outcome}`, (req, res) => {
    const order = findByTransaction(req.body.tran_id);
    if (!order) return res.redirect('/account/orders');
    db.prepare("UPDATE orders SET payment_status = 'failed' WHERE id = ? AND payment_status = 'unpaid'").run(order.id);
    res.redirect(`/account/orders/${order.id}?payment=${outcome === 'fail' ? 'failed' : 'cancelled'}`);
  });
}

// Cancels online orders that were never paid so their stock is released.
function expireUnpaidOrders(maxAgeMinutes = 60) {
  const stale = db.prepare(`SELECT id FROM orders WHERE payment_method = 'online' AND payment_status IN ('unpaid', 'failed')
    AND created_at < datetime('now', ?)`).all(`-${maxAgeMinutes} minutes`);
  for (const { id } of stale) {
    transaction(() => {
      const items = db.prepare("SELECT id, product_id, quantity FROM order_items WHERE order_id = ? AND status = 'pending'").all(id);
      for (const item of items) {
        db.prepare("UPDATE order_items SET status = 'cancelled' WHERE id = ?").run(item.id);
        if (item.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
      }
      db.prepare("UPDATE orders SET payment_status = 'expired' WHERE id = ?").run(id);
    });
  }
  return stale.length;
}

module.exports = router;
module.exports.callbacks = callbacks;
module.exports.expireUnpaidOrders = expireUnpaidOrders;
