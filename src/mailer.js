const nodemailer = require('nodemailer');
const { db } = require('./db');
const { formatMoney } = require('./util');

const SITE_NAME = 'Bazar';
const FROM = process.env.MAIL_FROM || `${SITE_NAME} <no-reply@localhost>`;

// Without SMTP settings, emails are printed to the console and kept in `outbox`
// so development and tests work without a mail server.
const transport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  })
  : null;

const outbox = [];

function sendMail({ to, subject, text }) {
  if (!to) return Promise.resolve();
  const message = { from: FROM, to, subject: `[${SITE_NAME}] ${subject}`, text };
  if (!transport) {
    outbox.push(message);
    if (outbox.length > 100) outbox.shift();
    if (process.env.NODE_ENV !== 'test') console.log(`[mail] to=${to} subject="${message.subject}"`);
    return Promise.resolve();
  }
  // Email failures must never break the request that triggered them.
  return transport.sendMail(message).catch((err) => console.error('[mail] failed:', err.message));
}

const baseUrl = () => process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

function orderPlaced(orderId) {
  const order = db.prepare('SELECT o.*, u.email, u.name FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?').get(orderId);
  if (!order) return;
  const items = db.prepare(`SELECT oi.*, s.name AS store_name, s.user_id AS vendor_id FROM order_items oi
    JOIN stores s ON s.id = oi.store_id WHERE oi.order_id = ?`).all(orderId);

  const lines = items.map((i) => `- ${i.product_name} x ${i.quantity} (${i.store_name}): ${formatMoney(i.unit_price * i.quantity)}`);
  sendMail({
    to: order.email,
    subject: `Order #${order.id} confirmed`,
    text: `Hi ${order.name},\n\nThanks for your order!\n\n${lines.join('\n')}\n\nTotal: ${formatMoney(order.total)}\n`
      + `Deliver to: ${order.shipping_name}, ${order.phone}, ${order.address}\n\n`
      + `Each seller ships their items separately. Track your order: ${baseUrl()}/account/orders/${order.id}\n`,
  });

  const byVendor = new Map();
  for (const item of items) {
    if (!byVendor.has(item.vendor_id)) byVendor.set(item.vendor_id, []);
    byVendor.get(item.vendor_id).push(item);
  }
  for (const [vendorId, vendorItems] of byVendor) {
    const vendor = db.prepare('SELECT email, name FROM users WHERE id = ?').get(vendorId);
    sendMail({
      to: vendor && vendor.email,
      subject: `New order #${order.id}`,
      text: `Hi ${vendor.name},\n\nYou have a new order:\n\n`
        + vendorItems.map((i) => `- ${i.product_name} x ${i.quantity}: ${formatMoney(i.unit_price * i.quantity)}`).join('\n')
        + `\n\nShip to: ${order.shipping_name}, ${order.phone}, ${order.address}\n\nManage it: ${baseUrl()}/vendor/orders\n`,
    });
  }
}

function itemStatusChanged(itemId) {
  const row = db.prepare(`SELECT oi.*, u.email, u.name FROM order_items oi JOIN orders o ON o.id = oi.order_id
    JOIN users u ON u.id = o.user_id WHERE oi.id = ?`).get(itemId);
  if (!row) return;
  sendMail({
    to: row.email,
    subject: `Order #${row.order_id}: ${row.product_name} is ${row.status}`,
    text: `Hi ${row.name},\n\n"${row.product_name}" from your order #${row.order_id} is now ${row.status}.\n\n`
      + `View your order: ${baseUrl()}/account/orders/${row.order_id}\n`,
  });
}

function storeStatusChanged(storeId) {
  const row = db.prepare('SELECT s.name AS store_name, s.status, u.email, u.name FROM stores s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(storeId);
  if (!row) return;
  const text = {
    approved: `Good news! Your store "${row.store_name}" has been approved and is now live.\n\n${baseUrl()}/vendor`,
    suspended: `Your store "${row.store_name}" has been suspended. Please contact the marketplace admin.`,
    pending: `Your store "${row.store_name}" is under review again.`,
  }[row.status];
  sendMail({ to: row.email, subject: `Your store is ${row.status}`, text: `Hi ${row.name},\n\n${text}\n` });
}

function payoutProcessed(payoutId) {
  const row = db.prepare(`SELECT p.*, u.email, u.name FROM payouts p JOIN stores s ON s.id = p.store_id
    JOIN users u ON u.id = s.user_id WHERE p.id = ?`).get(payoutId);
  if (!row) return;
  const text = row.status === 'paid'
    ? `Your payout of ${formatMoney(row.amount)} has been sent to ${row.method} (${row.account}).`
    : `Your payout request of ${formatMoney(row.amount)} was rejected. The amount is back in your balance.`;
  sendMail({
    to: row.email,
    subject: `Payout ${row.status}`,
    text: `Hi ${row.name},\n\n${text}${row.note ? `\n\nNote from admin: ${row.note}` : ''}\n`,
  });
}

module.exports = { sendMail, outbox, orderPlaced, itemStatusChanged, storeStatusChanged, payoutProcessed };
