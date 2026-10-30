const assert = require('node:assert/strict');
const base = process.env.BASE_URL || 'http://localhost:3000';
let sessionCookie = '';
async function request(path, options = {}, authenticated = true) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
  if (authenticated && sessionCookie) headers.Cookie = sessionCookie;
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) sessionCookie = setCookie.split(';')[0];
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}
(async () => {
  let result = await request('/api/session', {}, false);
  assert.equal(result.status, 200);
  assert.equal(result.body.classes.length, 26);
  for (const route of ['/', '/DB/1', '/DB/2', '/DB/3', '/DB/4']) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 200, `${route} should load`);
  }
  const absenceDb = await fetch(`${base}/DB/5`);
  assert.equal(absenceDb.status, 200, 'Database 5 page should load');
  const principalDb = await fetch(`${base}/DB/6`);
  assert.equal(principalDb.status, 200, 'Database 6 page should load');

  result = await request('/api/parent/birthdays', {}, false);
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body.students));
  result = await request('/api/parent/message', {}, false);
  assert.equal(result.status, 200);
  result = await request('/api/parent/verify', { method: 'POST', body: JSON.stringify({ studentId: 'NO-SUCH-STUDENT', className: '6A' }) }, false);
  assert.equal(result.status, 404);

  result = await request('/api/login', { method: 'POST', body: JSON.stringify({ staffId: 'Administrator', password: '@dm1n1str@t0r', mode: 'admin' }) }, false);
  assert.equal(result.status, 200, 'Administrator login should work');
  assert.equal(result.body.user.id, 'Administrator');
  result = await request('/api/admin/dashboard');
  assert.equal(result.status, 200);
  assert.equal(result.body.totalClasses, 26);
  result = await request('/api/admin/parent-tools/absence-reasons');
  assert.equal(result.status, 200);
  console.log('SMOKE TEST PASSED: public parent tools, administrator login, admin dashboard, 26 classes, DB/1–DB/4, and DB/5–DB/6 protected database pages.');
})().catch(error => { console.error('SMOKE TEST FAILED:', error.stack || error); process.exit(1); });
