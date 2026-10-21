// Offline receipt tests. The signed case runs in a child process with a throwaway Ed25519 key generated here
// (never the server's real key; nothing is read from .env or the environment of the host).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const CHILD = `
globalThis.fetch = async () => { throw new Error('offline test'); };
const { buildReceipt, verifyReceipt } = await import('./trust.js');
const data = { hello: 'world', n: 1 };
const r = buildReceipt({ endpoint: 'GET /api/rails', query: { amount: '100' }, amount: '10000', tx: '0xabc', payer: '0xdef', accessType: 'X402_FACILITATOR_SETTLED' }, data);
const ok = verifyReceipt({ payload: r.payload, signature: r.signature, data });
const badData = verifyReceipt({ payload: r.payload, signature: r.signature, data: { hello: 'tampered' } });
const tampered = verifyReceipt({ payload: r.payload.slice(0, -2) + (r.payload.endsWith('A') ? 'BB' : 'AA'), signature: r.signature });
console.log(JSON.stringify({ r, ok, badData, tampered }));
process.exit(0);`;
const run = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, ...env } }).toString().trim().split('\n').pop());

test('unsigned when no signing key: no fake signature', () => {
  const { r, ok } = run({});
  assert.equal(r.signed, false); assert.equal(r.signature, null); assert.equal(r.alg, 'none'); assert.ok(r.unsigned);
  assert.equal(r.endpoint, 'GET /api/rails'); assert.equal(r.tx, '0xabc'); assert.match(r.pubkey_url, /\/api\/proof\/pubkey$/);
  assert.equal(ok.valid, false); assert.equal(ok.signingEnabled, false);
});

test('signed receipt verifies; tampering and wrong data are caught', () => {
  const testKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const { r, ok, badData, tampered } = run({ SIGNING_KEY: testKey });
  assert.equal(r.signed, true); assert.equal(r.alg, 'Ed25519'); assert.ok(r.signature);
  assert.equal(r.response_sha256, crypto.createHash('sha256').update(JSON.stringify({ hello: 'world', n: 1 })).digest('hex'));
  assert.equal(ok.valid, true); assert.equal(ok.dataMatches, true);
  assert.equal(badData.valid, true); assert.equal(badData.dataMatches, false);
  assert.equal(tampered.valid, false);
});
