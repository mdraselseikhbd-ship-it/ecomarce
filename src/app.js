const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const { formatMoney } = require('./util');
const { loadUser, exposeFlash, csrf } = require('./middleware');
const { ensureAdmin } = require('./seed');
const paymentRoutes = require('./routes/payment');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

app.use('/public', express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use(express.urlencoded({ extended: false }));
app.use(paymentRoutes.callbacks);
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

app.locals.money = formatMoney;
app.locals.paymentLabel = (method) => ({ cod: 'Cash on delivery', online: 'Online (bKash/Nagad/Card)', bkash: 'bKash' }[method] || method);
app.use(loadUser);
app.use(exposeFlash);
app.use(csrf);
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.query = req.query;
  next();
});

app.use(require('./routes/auth'));
app.use(require('./routes/shop'));
app.use(require('./routes/cart'));
app.use(paymentRoutes);
app.use('/account', require('./routes/account'));
app.use('/vendor', require('./routes/vendor'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'The page you are looking for does not exist.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  const message = status === 500 ? 'Something went wrong on our side.' : err.message;
  res.status(status).render('error', { title: 'Error', message });
});

if (require.main === module) {
  ensureAdmin();
  setInterval(paymentRoutes.expireUnpaidOrders, 5 * 60 * 1000).unref();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Marketplace running at http://localhost:${port}`));
}

module.exports = app;
