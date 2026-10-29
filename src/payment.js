// SSLCommerz payment gateway (supports bKash, Nagad, Rocket, cards and net banking).
// Docs: https://developer.sslcommerz.com/doc/v4/
const STORE_ID = process.env.SSLCZ_STORE_ID;
const STORE_PASSWORD = process.env.SSLCZ_STORE_PASSWORD;
const HOST = process.env.SSLCZ_LIVE === 'true' ? 'https://securepay.sslcommerz.com' : 'https://sandbox.sslcommerz.com';

function isEnabled() {
  return Boolean(STORE_ID && STORE_PASSWORD);
}

const toTaka = (paisa) => (paisa / 100).toFixed(2);

// Creates a payment session and returns the URL to send the customer to.
async function createSession({ order, customer, itemCount, baseUrl }) {
  const body = new URLSearchParams({
    store_id: STORE_ID,
    store_passwd: STORE_PASSWORD,
    total_amount: toTaka(order.total),
    currency: 'BDT',
    tran_id: order.transaction_id,
    success_url: `${baseUrl}/payment/success`,
    fail_url: `${baseUrl}/payment/fail`,
    cancel_url: `${baseUrl}/payment/cancel`,
    ipn_url: `${baseUrl}/payment/ipn`,
    cus_name: order.shipping_name,
    cus_email: customer.email,
    cus_add1: order.address,
    cus_city: 'Dhaka',
    cus_country: 'Bangladesh',
    cus_phone: order.phone,
    shipping_method: 'NO',
    product_name: `Order #${order.id}`,
    product_category: 'general',
    product_profile: 'general',
    num_of_item: String(itemCount),
    value_a: String(order.id),
  });
  const res = await fetch(`${HOST}/gwprocess/v4/api.php`, { method: 'POST', body });
  const data = await res.json();
  if (data.status !== 'SUCCESS' || !data.GatewayPageURL) {
    throw new Error(`Payment gateway error: ${data.failedreason || 'unknown error'}`);
  }
  return data.GatewayPageURL;
}

// Asks SSLCommerz to confirm a payment. Callback data alone is never trusted.
async function validate(valId) {
  const params = new URLSearchParams({ val_id: valId, store_id: STORE_ID, store_passwd: STORE_PASSWORD, format: 'json' });
  const res = await fetch(`${HOST}/validator/api/validationserverAPI.php?${params}`);
  return res.json();
}

// True when the gateway's validation response matches the order exactly.
function isValidPayment(validation, order) {
  return Boolean(validation)
    && ['VALID', 'VALIDATED'].includes(validation.status)
    && validation.tran_id === order.transaction_id
    && validation.currency_type === 'BDT'
    && Math.round(Number(validation.currency_amount) * 100) === order.total;
}

module.exports = { isEnabled, createSession, validate, isValidPayment };
