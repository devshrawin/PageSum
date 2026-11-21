import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySensitive, normalizeHostEntry, hostMatchesList } from '../extension/lib/sensitive.js';

const c = (o) => classifySensitive({ url: 'https://example.com/', title: 'Example', hasPasswordField: false, blocklist: [], ...o });

test('not sensitive by default', () => {
  assert.deepEqual(c({}), { sensitive: false, reason: null });
  assert.deepEqual(classifySensitive({}), { sensitive: false, reason: null });
  assert.deepEqual(classifySensitive({ url: 'garbage' }), { sensitive: false, reason: null });
});

test('rule 1: blocklist, exact host and *. suffix, never notbank.com', () => {
  assert.deepEqual(c({ url: 'https://news.site.com/a', blocklist: ['news.site.com'] }), { sensitive: true, reason: 'blocklist' });
  assert.equal(c({ url: 'https://www.mybank.com/', blocklist: ['*.mybank.com'] }).reason, 'blocklist');
  assert.equal(c({ url: 'https://mybank.com/', blocklist: ['*.mybank.com'] }).reason, 'blocklist');
  assert.equal(c({ url: 'https://notmybank.com/', blocklist: ['*.mybank.com'] }).sensitive, false);
  assert.equal(c({ url: 'https://a.site.com/', blocklist: ['site.com'] }).sensitive, false, 'an exact entry does not match subdomains');
});

test('rule 2: login by password field or path', () => {
  assert.equal(c({ hasPasswordField: true }).reason, 'login');
  for (const p of ['/login', '/users/sign-in', '/auth/callback', '/account/password', '/reset-password', '/2fa', '/mfa/verify', '/signin']) {
    assert.equal(c({ url: 'https://example.com' + p }).reason, 'login', p);
  }
  assert.equal(c({ url: 'https://example.com/blog/authors' }).sensitive, false, 'authors is not auth');
  assert.equal(c({ url: 'https://example.com/loginfo' }).sensitive, false);
});

test('rule 3: banking by host or title', () => {
  assert.equal(c({ url: 'https://www.paypal.com/home' }).reason, 'banking');
  assert.equal(c({ url: 'https://wise.com/' }).reason, 'banking');
  assert.equal(c({ url: 'https://app.revolut.com/' }).reason, 'banking');
  assert.equal(c({ title: 'Net Banking - Dashboard' }).reason, 'banking');
  assert.equal(c({ title: 'Your credit union account' }).reason, 'banking');
  assert.equal(c({ url: 'https://example.com/', title: 'Demat account overview' }).reason, 'banking');
  assert.equal(c({ url: 'https://riverbank.example.com/' }).sensitive, false, 'riverbank is not bank');
  assert.equal(c({ title: 'A walk along the river bank' }).reason, 'banking', 'a title with the word bank is flagged: a deliberate false positive');
});

test('rule 4: health', () => {
  assert.equal(c({ url: 'https://mychart.example.org/' }).reason, 'health');
  assert.equal(c({ title: 'Lab results - Patient portal' }).reason, 'health');
  assert.equal(c({ title: 'Refill your prescription' }).reason, 'health');
  assert.equal(c({ url: 'https://example.com/pharmacy/orders' }).reason, 'health');
});

test('rule 5: payment paths', () => {
  for (const p of ['/checkout', '/checkout/step2', '/payment', '/billing/settings', '/pay']) {
    assert.equal(c({ url: 'https://shop.example.com' + p }).reason, 'payment', p);
  }
  assert.equal(c({ url: 'https://example.com/payments-history-blog' }).sensitive, false);
  assert.equal(c({ url: 'https://example.com/paying' }).sensitive, false);
});

test('order of precedence: blocklist > login > banking > health > payment', () => {
  assert.equal(c({ url: 'https://bank.com/login', hasPasswordField: true, blocklist: ['bank.com'] }).reason, 'blocklist');
  assert.equal(c({ url: 'https://bank.com/login' }).reason, 'login');
  assert.equal(c({ url: 'https://bank.com/checkout' }).reason, 'banking');
  assert.equal(c({ url: 'https://mychart.example.org/checkout' }).reason, 'health');
});

test('normalizeHostEntry and hostMatchesList', () => {
  assert.equal(normalizeHostEntry('https://Foo.com/x'), 'foo.com');
  assert.equal(normalizeHostEntry(' *.Bank.COM/path '), '*.bank.com');
  assert.equal(normalizeHostEntry('not a host'), '');
  assert.equal(normalizeHostEntry(''), '');
  assert.equal(hostMatchesList('a.bank.com', ['*.bank.com']), true);
  assert.equal(hostMatchesList('notbank.com', ['*.bank.com']), false);
  assert.equal(hostMatchesList('', ['x.com']), false);
});
