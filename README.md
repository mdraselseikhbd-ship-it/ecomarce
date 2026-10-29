# Bazar — Multivendor E-commerce

A multivendor marketplace where many sellers open their own stores and customers buy from all of them with **one cart and one checkout**. Each order is split per vendor, so every seller fulfils only their own items, and the marketplace keeps a commission on each sale.

Built with **Node.js 22 + Express 5 + EJS + SQLite** (the built-in `node:sqlite`, so there is no database server to install).

> **বাংলায়:** এটা একটা মাল্টিভেন্ডর ই-কমার্স সাইট। অনেক বিক্রেতা নিজের দোকান খুলে পণ্য বিক্রি করতে পারবে, ক্রেতা এক কার্টে বিভিন্ন দোকান থেকে কিনতে পারবে, আর অ্যাডমিন প্রতিটি বিক্রি থেকে কমিশন পাবে।

## Quick start

Requires Node.js 22.13 or newer and Git.

> **নিজের কম্পিউটারে চালাতে (Windows/Mac/Linux):** https://nodejs.org থেকে Node.js 22 LTS আর https://git-scm.com থেকে Git ইনস্টল করুন, তারপর নিচের কমান্ডগুলো একটা একটা করে চালান। `npm start` চলাকালীন টার্মিনাল খোলা রাখুন।

```bash
git clone https://github.com/mdraselseikhbd-ship-it/ecomarce.git
```

```bash
cd ecomarce
```

```bash
npm install
```

```bash
npm run seed
```

```bash
npm start
```

Open http://localhost:3000.

### Demo accounts (after `npm run seed`)

| Role     | Email                  | Password      |
|----------|------------------------|---------------|
| Admin    | admin@example.com      | admin123      |
| Vendor   | vendor1@example.com    | vendor123     |
| Vendor   | vendor2@example.com    | vendor123     |
| Customer | customer@example.com   | customer123   |

An admin account is created automatically on first start. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before the first run to choose your own.

## Features

**Customers**
- Browse, search, filter by category and sort products; browse individual stores
- One cart across many vendors (grouped by store)
- Pay with Cash on Delivery, or online with bKash, Nagad, Rocket or card through SSLCommerz
- Retry a failed online payment; unpaid online orders are cancelled after 1 hour and their stock released
- Order history with per-vendor item status, cancel items vendors haven't started yet
- Email for order confirmation and every status change
- Product reviews and ratings (only after the item is delivered)

**Vendors (sellers)**
- Register as a seller; the store goes live after admin approval
- Dashboard: sales, commission, earnings, pending items, low-stock warning
- Add, edit, hide and delete products with image upload
- See only their own order items and move them through `pending → processing → shipped → delivered` (or cancel, which restores stock)
- Payouts: see earned / paid / available balance and request a withdrawal to bKash, Nagad or bank
- Email when a new order arrives, when the store is approved and when a payout is processed
- Edit store name, phone and description

**Admin**
- Dashboard with gross sales, commission earned and top stores
- Approve / suspend vendor stores
- Manage categories, hide any product, view all orders and users
- Process vendor payout requests (mark paid with a transaction ID, or reject)
- Set the marketplace commission percentage

**Security**
- Passwords hashed with scrypt, session regeneration on login
- CSRF tokens on every form, role-based access for vendor and admin panels
- Vendors can only touch their own products and order items
- Stock is checked and decremented inside a database transaction at checkout
- Online payments are confirmed with the SSLCommerz validation API (transaction ID, amount and currency must match); callback data alone is never trusted
- Vendors don't see an online order until it is paid; payout requests can't exceed the available balance
- Prices are stored in paisa (integers), never floats

## Configuration

| Variable         | Default              | Purpose                                  |
|------------------|----------------------|------------------------------------------|
| `PORT`           | `3000`               | HTTP port                                |
| `SESSION_SECRET` | random per start     | Set this in production so logins survive restarts |
| `DB_FILE`        | `data/shop.db`       | SQLite database file                     |
| `ADMIN_EMAIL`    | `admin@example.com`  | First admin account                      |
| `ADMIN_PASSWORD` | `admin123`           | First admin password                     |
| `BASE_URL`       | `http://localhost:PORT` | Public URL of the site, used in emails and payment callbacks |
| `SSLCZ_STORE_ID` | —                    | SSLCommerz store ID. Online payment is offered only when this and the password are set |
| `SSLCZ_STORE_PASSWORD` | —              | SSLCommerz store password                |
| `SSLCZ_LIVE`     | `false`              | `true` for real payments; otherwise the SSLCommerz sandbox is used |
| `SMTP_HOST`      | —                    | SMTP server. Without it, emails are only printed to the console |
| `SMTP_PORT`      | `587`                | SMTP port (465 uses TLS)                 |
| `SMTP_USER` / `SMTP_PASS` | —           | SMTP login (for Gmail, use an App Password) |
| `MAIL_FROM`      | `Bazar <no-reply@localhost>` | Sender address                   |

### Online payment (SSLCommerz)

1. Get free sandbox credentials at https://developer.sslcommerz.com/registration/.
2. Start the app with `SSLCZ_STORE_ID` and `SSLCZ_STORE_PASSWORD` set. The checkout page then shows "Pay online".
3. SSLCommerz must be able to reach your site for the IPN callback, so set `BASE_URL` to your public URL in production.
4. When you have a live merchant account, set `SSLCZ_LIVE=true`.

For production, also put the app behind HTTPS and use a persistent session store (the default in-memory store loses sessions on restart).

## Project structure

```
src/
  app.js            Express setup and route mounting
  db.js             SQLite schema and helpers
  middleware.js     Auth, roles, CSRF and flash messages
  seed.js           Admin bootstrap and demo data
  mailer.js         Email notifications (SMTP or console)
  payment.js        SSLCommerz client
  payouts.js        Vendor balance calculation
  util.js           Password hashing, slugs, money formatting
  routes/
    auth.js         Login, register (customer or vendor), logout
    shop.js         Home, product list/detail, stores, reviews
    cart.js         Cart and multivendor checkout
    payment.js      Payment start, gateway callbacks, unpaid order expiry
    account.js      Customer orders and profile
    vendor.js       Seller dashboard, products, orders, settings
    admin.js        Admin dashboard and management
views/              EJS templates
public/css/         Stylesheet
test/               End-to-end tests (npm test)
```

## Tests

```bash
npm test
```

The tests run against an in-memory database with a fake SSLCommerz API and cover the full flow: a customer buying from two vendors, each vendor fulfilling only their own items, cancellation restoring stock, reviews after delivery, vendor approval, CSRF protection, image upload, online payment (including forged callbacks and expiry), emails and payouts.
