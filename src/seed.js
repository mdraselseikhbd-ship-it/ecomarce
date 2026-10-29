const { db, transaction } = require('./db');
const { hashPassword, uniqueSlug } = require('./util');

// Creates the first admin account if none exists yet.
function ensureAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existing) return;
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .run('Admin', email, hashPassword(password));
  console.log(`Created admin account: ${email} / ${password} (change this password!)`);
}

function createUser(name, email, password, role) {
  const found = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (found) return found.id;
  return Number(db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, hashPassword(password), role).lastInsertRowid);
}

function seedDemo() {
  ensureAdmin();
  transaction(() => {
    const categories = ['Electronics', 'Fashion', 'Home & Kitchen', 'Books', 'Grocery'];
    const catIds = {};
    for (const name of categories) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      db.prepare('INSERT OR IGNORE INTO categories (name, slug) VALUES (?, ?)').run(name, slug);
      catIds[name] = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;
    }

    const vendors = [
      {
        user: ['Rahim Uddin', 'vendor1@example.com'],
        store: ['Rahim Electronics', 'Phones, gadgets and accessories at fair prices.'],
        products: [
          ['Wireless Earbuds', 'Electronics', 1850, 40, 'Bluetooth 5.3 earbuds with 24h battery life.'],
          ['Power Bank 20000mAh', 'Electronics', 2200, 25, 'Fast charging power bank with dual USB output.'],
          ['Smart Watch', 'Electronics', 3500, 15, 'Fitness tracking, heart-rate monitor and notifications.'],
        ],
      },
      {
        user: ['Karima Begum', 'vendor2@example.com'],
        store: ['Deshi Fashion House', 'Handmade sarees, panjabis and more.'],
        products: [
          ['Cotton Panjabi', 'Fashion', 1450, 30, 'Comfortable cotton panjabi, sizes M to XXL.'],
          ['Jamdani Saree', 'Fashion', 6500, 8, 'Traditional handwoven Jamdani saree.'],
          ['Nakshi Kantha Cushion Cover', 'Home & Kitchen', 650, 50, 'Hand-stitched cushion cover, 16x16 inch.'],
        ],
      },
    ];

    for (const v of vendors) {
      const userId = createUser(v.user[0], v.user[1], 'vendor123', 'vendor');
      let store = db.prepare('SELECT id FROM stores WHERE user_id = ?').get(userId);
      if (!store) {
        const id = db.prepare("INSERT INTO stores (user_id, name, slug, description, status) VALUES (?, ?, ?, ?, 'approved')")
          .run(userId, v.store[0], uniqueSlug(db, 'stores', v.store[0]), v.store[1]).lastInsertRowid;
        store = { id: Number(id) };
        for (const [name, cat, price, stock, description] of v.products) {
          db.prepare(`INSERT INTO products (store_id, category_id, name, slug, description, price, stock)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(store.id, catIds[cat], name, uniqueSlug(db, 'products', name), description, price * 100, stock);
        }
      }
    }

    createUser('Demo Customer', 'customer@example.com', 'customer123', 'customer');
  });
  console.log('Demo data ready:');
  console.log('  vendor1@example.com / vendor123');
  console.log('  vendor2@example.com / vendor123');
  console.log('  customer@example.com / customer123');
}

if (require.main === module) seedDemo();

module.exports = { ensureAdmin, seedDemo };
