/*
 * Copyright 2026 Justlend V2 Utils. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { tronObj, getNetworkType, getDefaultAccount, triggerV2 } from '../utils/blockchain';
import { getContractsAddress } from '../utils/systemV2';

describe('getNetworkType', () => {
  const realTronWeb = tronObj.tronWeb;
  afterEach(() => {
    tronObj.tronWeb = realTronWeb;
    tronObj.network = null;
  });

  const withHost = (host) => {
    tronObj.tronWeb = { fullNode: { host } };
  };

  it.each([
    'https://nile.trongrid.io',
    'https://api.nileex.io',
    'https://API.NILEEX.IO/',
    'https://api.nileex.io/wallet',
  ])('infers Nile and resolves its registry from %s', host => {
    withHost(host);
    expect(getNetworkType()).toBe('nile');
    expect(getContractsAddress('MoolahProxy')).toBe('TFgrgsd8c37ByaZx1YxpBzazJS8bHsoP5c');
  });

  it('infers shasta from the node host (no longer mislabeled as main)', () => {
    withHost('https://api.shasta.trongrid.io');
    expect(getNetworkType()).toBe('shasta');
  });

  it('defaults mainnet hosts to main', () => {
    withHost('https://api.trongrid.io');
    expect(getNetworkType()).toBe('main');
    withHost('https://api.tronstack.io');
    expect(getNetworkType()).toBe('main');
  });

  it('an explicit tronObj.network override wins over host sniffing', () => {
    withHost('https://api.trongrid.io');
    tronObj.network = 'nile';
    expect(getNetworkType()).toBe('nile');
  });

  it('fails closed for a missing/unset host', () => {
    tronObj.tronWeb = {};
    expect(() => getNetworkType()).toThrow(/empty provider host.*set tronObj\.network/i);
  });

  it('fails closed for an unrecognized or lookalike host', () => {
    withHost('https://wallet-proxy.example.com');
    expect(() => getNetworkType()).toThrow(/Unknown TRON provider host/i);
    withHost('https://api.trongrid.io.attacker.example');
    expect(() => getNetworkType()).toThrow(/Unknown TRON provider host/i);
    withHost('https://api.nileex.io.attacker.example');
    expect(() => getNetworkType()).toThrow(/Unknown TRON provider host/i);
    withHost('https://api.nileex.io@attacker.example');
    expect(() => getNetworkType()).toThrow(/Unknown TRON provider host/i);
  });

  it('rejects invalid explicit network overrides', () => {
    withHost('https://api.trongrid.io');
    tronObj.network = 'mainnet';
    expect(() => getNetworkType()).toThrow(/expected main, nile, or shasta/i);
  });

  it('requires a configured contract registry for the selected network', () => {
    tronObj.network = 'shasta';
    expect(() => getContractsAddress('MoolahProxy')).toThrow(/No contract registry.*shasta/i);
  });

  it('does not resolve a mainnet proxy for an unknown injected provider', () => {
    withHost('https://wallet-proxy.example.com');
    expect(() => getContractsAddress('MoolahProxy')).toThrow(/Unknown TRON provider host/i);
  });
});

describe('getDefaultAccount', () => {
  const ADDR = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
  afterEach(() => {
    tronObj.defaultAccount = null;
    delete global.window;
  });

  it('returns tronObj.defaultAccount when set', () => {
    tronObj.defaultAccount = ADDR;
    expect(getDefaultAccount()).toBe(ADDR);
  });

  it('falls back to window.defaultAccount in the browser', () => {
    global.window = { defaultAccount: ADDR };
    expect(getDefaultAccount()).toBe(ADDR);
  });

  it('prefers tronObj.defaultAccount over the window global', () => {
    tronObj.defaultAccount = ADDR;
    global.window = { defaultAccount: 'TOtherAccountAddrrrrrrrrrrrrrrrrrrr' };
    expect(getDefaultAccount()).toBe(ADDR);
  });

  it('throws a clear error when nothing is configured (Node, no window)', () => {
    expect(() => getDefaultAccount()).toThrow(/No sender address configured/);
  });
});

describe('broadcast error privacy', () => {
  const realTronWeb = tronObj.tronWeb;
  let log;
  let broadcast;
  const signed = {
    txID: 'audit-transaction',
    raw_data_hex: 'AUDIT_NOT_RAW_TRANSACTION_DATA',
    signature: ['AUDIT_NOT_A_VALID_SIGNATURE'],
  };

  beforeEach(() => {
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
    broadcast = vi.fn();
    tronObj.defaultAccount = 'TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3';
    tronObj.tronWeb = {
      address: { toHex: (address) => address },
      transactionBuilder: {
        triggerSmartContract: vi.fn(async () => ({ result: { result: true }, transaction: { txID: 'unsigned' } })),
        triggerConstantContract: vi.fn(async () => ({ constant_result: ['00'] })),
      },
      trx: {
        sign: vi.fn(async () => signed),
        sendRawTransaction: broadcast,
      },
    };
  });

  afterEach(() => {
    tronObj.tronWeb = realTronWeb;
    tronObj.defaultAccount = null;
    vi.restoreAllMocks();
  });

  it.each([
    ['SERVER_BUSY', 'SERVER_BUSY'],
    ['A', 'A'],
    ['X'.repeat(63), 'X'.repeat(63)],
    ['X'.repeat(64), 'X'.repeat(64)],
    ['', 'broadcast rejected by node'],
    [undefined, 'broadcast rejected by node'],
    [{ nested: signed }, 'broadcast rejected by node'],
    ['BAD\nCODE', 'broadcast rejected by node'],
    ['lowercase', 'broadcast rejected by node'],
    ['X'.repeat(65), 'broadcast rejected by node'],
  ])(
    'does not expose signed fields or arbitrary messages when the node rejects with code %j',
    async (code, reason) => {
      broadcast.mockResolvedValue({ result: false, code, message: JSON.stringify(signed), transaction: signed });
      await expect(triggerV2(tronObj.defaultAccount, 'audit()')).rejects.toThrow(`Broadcast failed: ${reason}`);
      expect(log).toHaveBeenCalledWith(`triggerV2 error: Broadcast failed: ${reason}`);
      expect(JSON.stringify(log.mock.calls)).not.toContain(signed.signature[0]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(signed.raw_data_hex);
      expect(broadcast).toHaveBeenCalledWith(signed);
    },
  );

  it('preserves successful SDK responses without logging them', async () => {
    const result = { result: true, transaction: signed };
    broadcast.mockResolvedValue(result);
    await expect(triggerV2(tronObj.defaultAccount, 'audit()')).resolves.toBe(result);
    expect(log).not.toHaveBeenCalled();
  });
});
