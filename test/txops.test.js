'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { nameOpsFromTx, extractFromAsm, canonicalizeOp } = require('../lib/txops');

describe('txops', () => {
  it('canonicalizes consensus opcodes only', () => {
    assert.equal(canonicalizeOp('OP_NAME_NEW'), 'NAME_NEW');
    assert.equal(canonicalizeOp('name_firstupdate'), 'NAME_FIRSTUPDATE');
    assert.equal(canonicalizeOp('NAME_UPDATE'), 'NAME_UPDATE');
    assert.equal(canonicalizeOp('OP_NAME_RENEW'), null);
    assert.equal(canonicalizeOp('NAME_TRANSFER'), null);
  });

  it('parses NAME_UPDATE from ASM', () => {
    const nameHex = Buffer.from('d/test', 'utf8').toString('hex');
    const valueHex = Buffer.from('{"ip":"1.2.3.4"}', 'utf8').toString('hex');
    const parsed = extractFromAsm(`OP_DUP OP_HASH160 dead OP_EQUALVERIFY OP_CHECKSIG OP_NAME_UPDATE ${nameHex} ${valueHex}`);
    assert.equal(parsed.op, 'NAME_UPDATE');
    assert.equal(parsed.name, 'd/test');
    assert.equal(parsed.value, '{"ip":"1.2.3.4"}');
  });

  it('parses NAME_NEW from ASM without a name', () => {
    const parsed = extractFromAsm('OP_NAME_NEW aabbccddeeff');
    assert.equal(parsed.op, 'NAME_NEW');
    assert.equal(parsed.name, null);
  });

  it('prefers scriptPubKey.nameOp over ASM', () => {
    const tx = {
      txid: 'ab'.repeat(32),
      vout: [{
        scriptPubKey: {
          asm: 'OP_NAME_UPDATE 00 00',
          nameOp: { op: 'name_firstupdate', name: 'd/bitcoin', value: '{"map":{}}' },
          address: 'Nabc',
        },
      }],
    };
    const ops = nameOpsFromTx(tx);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].op, 'NAME_FIRSTUPDATE');
    assert.equal(ops[0].name, 'd/bitcoin');
    assert.equal(ops[0].address, 'Nabc');
  });
});
