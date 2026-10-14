import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';
import * as system from '../utils/systemV2';
import * as blockchain from '../utils/blockchain';

const ACCOUNT = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
const VAULT = 'THpxp8RpCUGk55dV7oL1LfxDeP9QvouxmM';
const MARKET_ID = `0x${'ab'.repeat(32)}`;
const MARKET = {
  borrowAddress: 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR',
  collateralAddress: 'TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz',
  oracle: 'TUDXEUA6hNiWPm54cMifoxCZU28zRu6bPc',
  irm: 'TSsuwbvUKAVgRmSghXT7i38PgHWpW12wQ1',
  lltv: '0.75',
};
let previous;

beforeEach(() => {
  previous = { network: blockchain.tronObj.network, defaultAccount: blockchain.tronObj.defaultAccount };
  blockchain.tronObj.network = 'main';
  blockchain.tronObj.defaultAccount = ACCOUNT;
  // Offline boundary checks: no signing, broadcasting, or RPC calls.
  vi.spyOn(blockchain, 'triggerV2').mockResolvedValue({ transaction: { txID: 'mock' } });
  vi.spyOn(blockchain, 'view').mockResolvedValue(['64']);
});

afterEach(() => {
  Object.assign(blockchain.tronObj, previous);
  vi.restoreAllMocks();
});

const entries = [
  {
    name: 'redeemFromVault', assetIndex: 0, shareIndex: null,
    run: (assets, shares) => system.redeemFromVault(VAULT, assets, 6, ACCOUNT, ACCOUNT, shares),
  },
  {
    name: 'redeemTrxFromVault', assetIndex: 1, shareIndex: null,
    // Real vault share decimals are 18, but assets must still be encoded as SUN.
    run: (assets, shares) => system.redeemTrxFromVault(VAULT, assets, 18, shares, ACCOUNT, ACCOUNT),
  },
  {
    name: 'repay', assetIndex: 1, shareIndex: 2,
    run: (assets, shares) => system.repay(MARKET, assets, 6, shares, ACCOUNT),
  },
  {
    name: 'repayWithTrx', assetIndex: 1, shareIndex: 2, trxFunding: true,
    run: (assets, shares) => system.repayWithTrx(MARKET, assets, shares, ACCOUNT),
  },
  {
    name: 'getLoanTokenAmountNeed', assetIndex: 1, shareIndex: 2, read: true,
    run: (assets, shares) => system.getLoanTokenAmountNeed(MARKET_ID, assets, shares, 6),
  },
  {
    name: 'liquidate', assetIndex: 2, shareIndex: 3,
    run: (assets, shares) => system.liquidate(MARKET_ID, ACCOUNT, assets, shares, 6),
  },
];

describe.each(entries)('$name amount/share mode', entry => {
  const calls = () => (entry.read ? blockchain.view : blockchain.triggerV2).mock.calls;

  it.each([
    ['omitted', undefined], ['null', null], ['number', 0], ['string', '0'],
    ['decimal zero string', '0.0'], ['bigint', 0n], ['BigNumber', new BigNumber(0)],
  ])('treats %s zero shares as asset mode', async (_, zero) => {
    await entry.run('1.25', zero);
    expect(calls()).toHaveLength(1);
    const [, selector, parameters, options] = calls()[0];
    expect(parameters[entry.assetIndex].value).toBe('1250000');
    if (entry.shareIndex == null) expect(selector).toMatch(/^withdraw\(/);
    else expect(parameters[entry.shareIndex].value).toBe(0);
    if (entry.trxFunding) expect(options.callValue).toBe('1250000');
  });

  it.each([
    ['number', 7, '7'],
    ['large string', '9007199254740993', '9007199254740993'],
    ['bigint', 9007199254740993n, '9007199254740993'],
    ['BigNumber', new BigNumber('9007199254740993'), '9007199254740993'],
    ['maximum uint256', (2n ** 256n - 1n).toString(), (2n ** 256n - 1n).toString()],
  ])('keeps %s shares exact without decimal scaling', async (_, shares, expected) => {
    await entry.run(0, shares);
    const [, selector, parameters] = calls()[0];
    if (entry.shareIndex == null) {
      expect(selector).toMatch(/^redeem\(/);
      expect(parameters[entry.assetIndex].value).toBe(expected);
    } else {
      expect(parameters[entry.assetIndex].value).toBe(0);
      expect(parameters[entry.shareIndex].value).toBe(expected);
    }
  });

  it.each([
    ['negative', '-1'], ['fractional', '0.5'], ['NaN', NaN], ['infinite', Infinity],
    ['malformed', 'abc'], ['empty string', ''], ['boolean', false], ['array', []],
    ['object', {}], ['coercible object', { valueOf: () => 7 }], ['unsafe number', Number.MAX_SAFE_INTEGER + 1],
    ['overflow', (2n ** 256n).toString()],
  ])('rejects %s shares before any chain call', async (_, shares) => {
    await expect(entry.run('1', shares)).rejects.toThrow(/Invalid shares/);
    expect(blockchain.triggerV2).not.toHaveBeenCalled();
    expect(blockchain.view).not.toHaveBeenCalled();
  });
});

describe('exclusive modes and TRX units', () => {
  it.each(entries.filter(entry => !entry.trxFunding))('$name rejects simultaneous asset and share amounts', async entry => {
    await expect(entry.run('1', '1')).rejects.toThrow(/Choose assets or shares/);
    expect(blockchain.triggerV2).not.toHaveBeenCalled();
    expect(blockchain.view).not.toHaveBeenCalled();
  });

  it.each([6, 18, undefined])('ignores legacy TRX decimals %s and preserves receiver/owner arguments', async decimals => {
    const explicitProvider = ACCOUNT; // Address fixture; not a verified deployment.
    await system.redeemTrxFromVault(VAULT, '1.0000019', decimals, '0', ACCOUNT, ACCOUNT, explicitProvider);
    expect(blockchain.triggerV2).toHaveBeenCalledTimes(1);
    expect(blockchain.triggerV2).toHaveBeenCalledWith(
      explicitProvider, 'withdraw(address,uint256,address,address)',
      [
        { type: 'address', value: VAULT }, { type: 'uint256', value: '1000001' },
        { type: 'address', value: ACCOUNT }, { type: 'address', value: ACCOUNT },
      ], {},
    );
  });

  it('retains the human-TRX funding budget for share-based repayment', async () => {
    await system.repayWithTrx(MARKET, '1.25', new BigNumber('9007199254740993'), ACCOUNT);
    const [, , parameters, options] = blockchain.triggerV2.mock.calls[0];
    expect(parameters[1].value).toBe(0);
    expect(parameters[2].value).toBe('9007199254740993');
    expect(options.callValue).toBe('1250000');
  });

  it('keeps an explicit raw-SUN budget authoritative for share-based repayment', async () => {
    await system.repayWithTrx(MARKET, null, '2', ACCOUNT, '123', undefined, { callValue: '999' });
    const [, , parameters, options] = blockchain.triggerV2.mock.calls[0];
    expect(parameters[1].value).toBe(0);
    expect(parameters[2].value).toBe('2');
    expect(options.callValue).toBe('123');
  });
});

describe('Nile rewards fail closed', () => {
  it.each([
    ['getMerkleRoot', () => system.getMerkleRoot(0)],
    ['isClaimed', () => system.isClaimed(0, 1)],
    ['multiClaim', () => system.multiClaim([{ merkleIndex: 0, index: 1, amount: '1', merkleProof: [] }])],
  ])('%s rejects the missing default without a chain call', async (_, run) => {
    blockchain.tronObj.network = 'nile';
    await expect(run()).rejects.toThrow(/No MerkleDistributor contract is configured.*nile/);
    expect(blockchain.view).not.toHaveBeenCalled();
    expect(blockchain.triggerV2).not.toHaveBeenCalled();
  });

  it('preserves explicit distributor overrides without choosing a mainnet fallback', async () => {
    blockchain.tronObj.network = 'nile';
    // Valid address fixture only; mocked calls do not certify a deployment.
    const explicit = ACCOUNT;
    await system.getMerkleRoot(0, explicit);
    await system.isClaimed(0, 1, explicit);
    await system.multiClaim([{ merkleIndex: 0, index: 1, amount: ['0', '1'], merkleProof: [] }], explicit);
    expect(blockchain.view.mock.calls.map(call => call[0])).toEqual([explicit, explicit]);
    expect(blockchain.triggerV2.mock.calls[0][0]).toBe(explicit);
    expect(blockchain.triggerV2.mock.calls[0][1]).toBe('multiClaim((uint256,uint256,uint256[],bytes32[])[])');
  });
});
