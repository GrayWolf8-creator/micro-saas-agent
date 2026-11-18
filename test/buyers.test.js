import test from 'node:test';
import assert from 'node:assert/strict';
import { payerId, isOwnPayer, resetOwnPayers, GW8_OWN_WALLET_ADDRESSES } from '../buyers.js';

const OWN = '0x605885d301e739a78ebceb60f955df392ad6c1f1';
const OTHER = '0xaa34bd941511cc82a19878e2efbe0bd7077e1db3';
const EXTRA = '0x00000000000000000000000000000000000000aa';

function withEnv(value, fn) {
  const prev = process.env.GW8_OWN_WALLETS;
  if (value === undefined) delete process.env.GW8_OWN_WALLETS;
  else process.env.GW8_OWN_WALLETS = value;
  resetOwnPayers();
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.GW8_OWN_WALLETS;
    else process.env.GW8_OWN_WALLETS = prev;
    resetOwnPayers();
  }
}

test('built-in GW8 test wallet is self even with no GW8_OWN_WALLETS env', () => {
  withEnv(undefined, () => {
    assert.ok(GW8_OWN_WALLET_ADDRESSES.includes(OWN));
    assert.equal(isOwnPayer(payerId(OWN)), true);
    assert.equal(isOwnPayer(payerId(OWN.toUpperCase())), true);
    assert.equal(isOwnPayer(payerId(OTHER)), false);
    assert.equal(isOwnPayer(null), false);
    assert.equal(isOwnPayer(''), false);
    assert.equal(isOwnPayer(OTHER), false, 'raw address is not an id');
  });
});

test('GW8_OWN_WALLETS adds more public addresses without dropping the built-in list', () => {
  withEnv(` ${EXTRA},not-an-address,${OTHER.toUpperCase()} `, () => {
    assert.equal(isOwnPayer(payerId(OWN)), true);
    assert.equal(isOwnPayer(payerId(EXTRA)), true);
    assert.equal(isOwnPayer(payerId(OTHER)), true);
    assert.equal(isOwnPayer(payerId('0x00000000000000000000000000000000000000bb')), false);
  });
});
