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
const TRUSTED_TRONGRID_HOSTS = new Set([
  'api.trongrid.io',
  'api.tronstack.io',
  'nile.trongrid.io',
  'api.shasta.trongrid.io',
  'shasta.trongrid.io',
]);

export const validateTrustedFullHost = (input, allowUntrusted = false) => {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid JUSTLEND_FULLHOST URL: ${input}`);
  }
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('JUSTLEND_FULLHOST must use HTTPS (HTTP is allowed only for loopback)');
  }
  if (!allowUntrusted && !isLoopback && !TRUSTED_TRONGRID_HOSTS.has(url.hostname)) {
    throw new Error(
      `Untrusted JUSTLEND_FULLHOST host: ${url.hostname}. Set ` +
        'JUSTLEND_ALLOW_UNTRUSTED_FULLHOST=true only for an operator-controlled node.',
    );
  }
  return url.toString().replace(/\/$/, '');
};

const env =
  typeof process !== 'undefined' && process.env ? process.env : {};
const configuredFullHost = env.JUSTLEND_FULLHOST || 'https://api.trongrid.io';

const Config = {
  chain: {
    // Default the keyless, read-only TronWeb instance to MAINNET. Override per-deploy via
    // the JUSTLEND_FULLHOST env var (Node), or by injecting `tronObj.tronWeb`
    // (browser wallet / custom node). `process` is guarded so this stays safe in
    // the browser bundle. For testnet use e.g. JUSTLEND_FULLHOST=https://nile.trongrid.io
    fullHost: validateTrustedFullHost(
      configuredFullHost,
      env.JUSTLEND_ALLOW_UNTRUSTED_FULLHOST === 'true',
    ),
  },
  feeLimit: 200000000,
  trxPrecision: 1e6,
  // TetherToken-class tokens whose `approve` REVERTs on a non-zero→non-zero
  // change (require approve(0) first). Addresses are globally unique, so this is
  // a flat allowlist checked across networks. Consumers can extend it at runtime.
  resetToZeroTokens: [
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // mainnet USDT (TetherToken)
    'TMwFHYXLJaRUPeW6421aqXL4ZEzPRFGkGT', // mainnet USDJ (TetherToken-derived)
  ],
  contracts: {
   main:{
     MoolahProxy: 'TRpY4gn6hHxA8x6oMtb3v3A37edkmaeY8j',
     TrxProviderProxy: 'TGBHLgstjZQCRVNx3UZTD3UaQaWYxa4nM6',
     MerkleDistributor: 'TQoiXqruw4SqYPwHAd6QiNZ3ES4rLsejAj',
     MerkleDistributorNEWUSDD: 'TYxJzmeDyxuxFbaGywjivfkft75qLeS485',
     PublicLiquidatorProxy: 'TGDuQaHtvadVL5z9PMM874CaehQnwf3qJi',
     WtrxContractProxy: 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR',
   },
   nile:{
     MoolahProxy: 'TFgrgsd8c37ByaZx1YxpBzazJS8bHsoP5c',
     TrxProviderProxy: 'TMRZwenUVHPvnxhwDDQLY4SEmmwXvtKRjz',
     MerkleDistributor: 'TKQ5VVJPsoZDD7NqQ8ffhFwzeRp45XLSGt',
     PublicLiquidatorProxy: 'TLvPrXHVQCA54gLQjLfoNi5XQ6WqhXCEps',
     WtrxContractProxy: 'TYsbWxNnyTgsZaTFaue9hqpxkU3Fkco94a',
   }
  },
}

export default Config;
