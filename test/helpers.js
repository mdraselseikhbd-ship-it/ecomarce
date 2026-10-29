const assert = require('node:assert/strict');

// Starts the app on a random port with a fresh in-memory database and demo data.
// Must be called before anything else requires src/ so the env vars take effect.
async function startServer(env = {}) {
  Object.assign(process.env, { DB_FILE: ':memory:', NODE_ENV: 'test' }, env);
  const app = require('../src/app');
  const { seedDemo } = require('../src/seed');
  const log = console.log;
  console.log = () => {};
  seedDemo();
  console.log = log;
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// Minimal browser: keeps the session cookie and the latest CSRF token.
function client(base) {
  let cookie = '';
  let csrf = '';
  async function request(method, path, form) {
    const multipart = form instanceof FormData;
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { cookie, ...(form && !multipart ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: multipart ? form : form ? new URLSearchParams({ _csrf: csrf, ...form }) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const body = await res.text();
    const match = body.match(/name="_csrf" value="([^"]+)"/);
    if (match) csrf = match[1];
    return { status: res.status, location: res.headers.get('location'), body, setCookie };
  }
  return {
    get: (path) => request('GET', path),
    post: (path, form = {}) => request('POST', path, form),
    postMultipart: (path, formData) => request('POST', path, formData),
    async login(email, password) {
      await this.get('/login');
      const res = await this.post('/login', { email, password });
      assert.equal(res.status, 302, 'login should redirect');
      await this.get('/'); // login starts a new session, so pick up its CSRF token
      return res;
    },
  };
}

module.exports = { startServer, client };
