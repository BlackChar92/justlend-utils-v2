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
import { describe, it, expect, afterEach } from 'vitest';
import { tronObj, getNetworkType, getDefaultAccount } from '../utils/blockchain';
import { getContractsAddress } from '../utils/systemV2';
import Config, { validateTrustedFullHost } from '../config';

describe('getNetworkType', () => {
  const realTronWeb = tronObj.tronWeb;
  afterEach(() => {
    tronObj.tronWeb = realTronWeb;
    tronObj.network = null;
  });

  const withHost = (host) => {
    tronObj.tronWeb = { fullNode: { host } };
  };

  it('infers nile from the node host', () => {
    withHost('https://nile.trongrid.io');
    expect(getNetworkType()).toBe('nile');
  });

  it.each([
    ['https://api.trongrid.io', 'main'],
    ['https://api.tronstack.io', 'main'],
    ['https://nile.trongrid.io', 'nile'],
    ['https://api.nileex.io', 'nile'],
    ['https://api.shasta.trongrid.io', 'shasta'],
    ['https://shasta.trongrid.io', 'shasta'],
  ])('accepts and consistently identifies the official endpoint %s', (host, network) => {
    expect(validateTrustedFullHost(`${host}/`)).toBe(host);
    withHost(host);
    expect(getNetworkType()).toBe(network);
  });

  it('resolves Nile contracts for the official RPC alias instead of mainnet defaults', () => {
    withHost('https://api.nileex.io');
    expect(getContractsAddress('MoolahProxy')).toBe(Config.contracts.nile.MoolahProxy);
    expect(getContractsAddress('MoolahProxy')).not.toBe(Config.contracts.main.MoolahProxy);
  });

  it('does not trust or infer a network from a Nile-alias lookalike', () => {
    const host = 'https://api.nileex.io.attacker.example';
    expect(() => validateTrustedFullHost(host)).toThrow(/Untrusted/);
    withHost(host);
    expect(() => getNetworkType()).toThrow(/Unknown TRON provider host/i);
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
