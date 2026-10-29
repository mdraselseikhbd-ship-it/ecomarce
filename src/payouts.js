const { db } = require('./db');

// Only orders that are actually payable count: COD orders, or online orders that were paid.
const PAYABLE_ORDER = "(o.payment_method != 'online' OR o.payment_status = 'paid')";

// A vendor earns the item price minus commission once an item is delivered.
// Requested and paid payouts are subtracted; rejected ones return to the balance.
function storeBalance(storeId) {
  const earned = db.prepare(`SELECT COALESCE(SUM(oi.unit_price * oi.quantity - oi.commission), 0) AS n
    FROM order_items oi WHERE oi.store_id = ? AND oi.status = 'delivered'`).get(storeId).n;
  const totals = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS paid,
      COALESCE(SUM(CASE WHEN status = 'requested' THEN amount END), 0) AS requested
    FROM payouts WHERE store_id = ?`).get(storeId);
  return { earned, ...totals, available: earned - totals.paid - totals.requested };
}

module.exports = { PAYABLE_ORDER, storeBalance };
