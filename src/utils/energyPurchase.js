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

import { TronWeb } from 'tronweb';

export const ENERGY_PURCHASE_PATHS = Object.freeze({
  config: '/v1/config',
  currentPrice: '/v1/price/current',
  poolHealth: '/v1/pool/health',
  quote: '/v1/price',
  buy: '/v1/consumer/energy/buy',
  order: id => `/v1/consumer/energy/orders/${encodeURIComponent(String(id))}`
});

export const ENERGY_PURCHASE_TERMINAL_STATES = Object.freeze([
  'delivered',
  'partial',
  'failed',
  'expired',
  'cancelled'
]);

const PAYMENT_RISK_PREFIX = 'justlend_energy_purchase_risk:';
const PAYMENT_LOCK_PREFIX = 'justlend_energy_purchase_lock:';
const DEFAULT_ORDER_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PAYMENT_RETRY_MS = 2 * 60 * 1000;
const DEFAULT_PURCHASE_INTENT_TTL_MS = 30 * 60 * 1000;
const DETERMINISTIC_PRE_BROADCAST_CODES = new Set([
  'ADDR_OVERFLOW',
  'BAD_REQUEST',
  'CONFIG_INVALID',
  'EMPTY_RECEIVERS',
  'INVALID_DURATION',
  'INVALID_RECEIVERS',
  'PAYMENT_CALC_FAILED',
  'POOL_INSUFFICIENT',
  'PRICE_MOVED',
  'RECEIVER_IS_CONTRACT',
  'TX_EXPIRED'
]);
const activePayerPurchases = new Set();

export class EnergyPurchaseError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = 'EnergyPurchaseError';
    this.code = code;
    this.status = options.status;
    this.isBusinessError = options.isBusinessError === true;
    this.retryable = options.retryable === true;
    this.details = options.details;
    this.paymentRisk = options.paymentRisk;
    this.cause = options.cause;
  }
}

const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeBaseUrl(baseUrl, allowInsecureLocalhost) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new EnergyPurchaseError(
      'CONFIG_MISSING',
      'Energy purchase API baseUrl is required; this library intentionally has no production fallback.'
    );
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (cause) {
    throw new EnergyPurchaseError('CONFIG_INVALID', 'Energy purchase API baseUrl must be a valid URL.', { cause });
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(allowInsecureLocalhost === true && local && parsed.protocol === 'http:')) {
    throw new EnergyPurchaseError(
      'CONFIG_INVALID',
      'Energy purchase API baseUrl must use HTTPS; HTTP is allowed only for localhost with allowInsecureLocalhost.'
    );
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function validateAddress(address, label) {
  const isBase58 = typeof address === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  if (!isBase58 || !TronWeb.isAddress(address)) {
    throw new EnergyPurchaseError('INVALID_ADDRESS', `${label} must be a Base58Check TRON address.`);
  }
}

function validatePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new EnergyPurchaseError('INVALID_AMOUNT', `${label} must be a positive safe integer.`);
  }
}

function validateQuoteInput(input, config) {
  const receivers = input?.receivers;
  if (!Array.isArray(receivers) || receivers.length === 0) {
    throw new EnergyPurchaseError('EMPTY_RECEIVERS', 'At least one energy receiver is required.');
  }
  receivers.forEach((address, index) => validateAddress(address, `receivers[${index}]`));
  validatePositiveInteger(input.energyPerReceiver, 'energyPerReceiver');

  if (!config || typeof config !== 'object') {
    throw new EnergyPurchaseError('INVALID_RESPONSE', 'Energy purchase configuration is unavailable.');
  }
  const min = Number(config.min_energy);
  const max = Number(config.max_energy);
  const maxReceivers = Number(config.max_batch_receivers);
  if (![min, max, maxReceivers].every(Number.isSafeInteger) || min <= 0 || max < min || maxReceivers <= 0) {
    throw new EnergyPurchaseError('INVALID_RESPONSE', 'Energy purchase limits returned by the API are invalid.');
  }
  if (input.energyPerReceiver < min || input.energyPerReceiver > max) {
    throw new EnergyPurchaseError('INVALID_AMOUNT', `energyPerReceiver must be between ${min} and ${max}.`);
  }
  if (receivers.length > maxReceivers) {
    throw new EnergyPurchaseError('ADDR_OVERFLOW', `A maximum of ${maxReceivers} receivers is allowed.`);
  }
  const durations = Array.isArray(config.supported_durations)
    ? config.supported_durations.filter(value => typeof value === 'string' && value.trim())
    : [];
  if (typeof input.duration !== 'string' || !durations.includes(input.duration)) {
    throw new EnergyPurchaseError(
      'INVALID_DURATION',
      'duration must be explicitly selected from the live /v1/config supported_durations list.'
    );
  }
  validateAddress(config.payment_address, 'config payment_address');
}

function normalizeHex(value) {
  return typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : '';
}

function transactionExecution(value) {
  const result = value?.receipt?.result ?? value?.ret?.[0]?.contractRet;
  if (typeof result !== 'string' || !result.trim()) return 'unknown';
  return result.toUpperCase() === 'SUCCESS' ? 'success' : 'failed';
}

function hasTransactionInfo(value, txId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const responseId = normalizeHex(value.id);
  return responseId ? responseId === normalizeHex(txId) : Boolean(value.receipt || value.blockNumber !== undefined);
}

function isTransactionNotFound(error) {
  return String(error?.message || error).toLowerCase().includes('transaction not found');
}

function rpcFingerprint(tronWeb) {
  const endpoints = [tronWeb?.fullNode?.host, tronWeb?.solidityNode?.host, tronWeb?.eventServer?.host]
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => {
      try {
        const parsed = new URL(value);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, '')}`;
      } catch {
        return String(value).trim();
      }
    });
  return endpoints.length ? [...new Set(endpoints)].join('|') : '';
}

async function consumerBuyMemo(receivers, energyPerReceiver, duration) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function' || typeof globalThis.TextEncoder !== 'function') {
    throw new EnergyPurchaseError('CONFIG_MISSING', 'Web Crypto SHA-256 and TextEncoder are required for payment intent binding.');
  }
  const payload = ['a6-buy-v1', String(energyPerReceiver), duration, ...receivers].join('\u0000');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `a6-buy-v1:${hex}`;
}

function attachMemo(tronWeb, transaction, memo) {
  if (!transaction || typeof transaction !== 'object' || !transaction.raw_data) {
    throw new EnergyPurchaseError('INVALID_UNSIGNED_TX', 'tronWeb returned a transaction without raw_data.');
  }
  const txJsonToPb = tronWeb?.utils?.transaction?.txJsonToPb;
  const txPbToRawDataHex = tronWeb?.utils?.transaction?.txPbToRawDataHex;
  const txPbToTxID = tronWeb?.utils?.transaction?.txPbToTxID;
  if (![txJsonToPb, txPbToRawDataHex, txPbToTxID].every(fn => typeof fn === 'function')) {
    throw new EnergyPurchaseError(
      'CONFIG_MISSING',
      'tronWeb transaction protobuf utilities are required to bind the payment memo safely.'
    );
  }
  const payable = {
    ...transaction,
    raw_data: { ...transaction.raw_data, data: Array.from(new TextEncoder().encode(memo), byte => byte.toString(16).padStart(2, '0')).join('') }
  };
  const protobuf = txJsonToPb(payable);
  payable.raw_data_hex = normalizeHex(txPbToRawDataHex(protobuf));
  payable.txID = normalizeHex(txPbToTxID(protobuf));
  if (!payable.txID || !payable.raw_data_hex) {
    throw new EnergyPurchaseError('INVALID_UNSIGNED_TX', 'Unable to derive the memo-bound transaction identity.');
  }
  return payable;
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function defaultPaymentLock() {
  try {
    const locks = globalThis.navigator?.locks;
    if (typeof locks?.request !== 'function') return null;
    return {
      tryRunExclusive: (key, task) =>
        locks.request(key, { mode: 'exclusive', ifAvailable: true }, lock => {
          if (!lock) {
            throw new EnergyPurchaseError(
              'PURCHASE_IN_PROGRESS',
              'Another energy purchase is already in progress for this payer.'
            );
          }
          return task();
        })
    };
  } catch {
    return null;
  }
}

function requireRiskStorage(storage) {
  if (
    !storage ||
    typeof storage.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    typeof storage.removeItem !== 'function'
  ) {
    throw new EnergyPurchaseError(
      'RISK_STORE_UNAVAILABLE',
      'Energy purchase requires durable risk storage; provide a storage adapter in Node.js.'
    );
  }
  return storage;
}

function riskStoreError(message, cause) {
  return new EnergyPurchaseError('RISK_STORE_UNAVAILABLE', message, { cause });
}

function recoveredOrderMetadata(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) return undefined;
  const batch = order.batch && typeof order.batch === 'object' && !Array.isArray(order.batch)
    ? {
        id: order.batch.id,
        state: order.batch.state
      }
    : undefined;
  const payment = order.payment && typeof order.payment === 'object' && !Array.isArray(order.payment)
    ? { tx_hash: order.payment.tx_hash }
    : undefined;
  return { ...(batch ? { batch } : {}), ...(payment ? { payment } : {}) };
}

/** Strip every replayable credential before a risk crosses the storage/API boundary. */
function metadataOnlyRisk(risk) {
  const { signedRequest: _signedRequest, recoveredOrder, ...metadata } = risk || {};
  const safeRecoveredOrder = recoveredOrderMetadata(recoveredOrder);
  return safeRecoveredOrder ? { ...metadata, recoveredOrder: safeRecoveredOrder } : metadata;
}

function assertRiskRecord(risk, payerAddress) {
  const hasIntentId = typeof risk?.intentId === 'string' && risk.intentId.length > 0;
  const hasSignedTxId = typeof risk?.signedTxId === 'string' && risk.signedTxId.length > 0;
  const validStateIdentity =
    (risk?.state === 'preparing' && hasIntentId && !hasSignedTxId) ||
    (risk?.state === 'signed' && hasIntentId && hasSignedTxId) ||
    // Backward compatibility for risk records written before intents existed.
    (risk?.state === undefined && !hasIntentId && hasSignedTxId);
  const validTimes =
    Number.isSafeInteger(risk?.createdAt) &&
    risk.createdAt >= 0 &&
    Number.isSafeInteger(risk?.expiresAt) &&
    risk.expiresAt >= risk.createdAt;
  if (
    !risk ||
    typeof risk !== 'object' ||
    Array.isArray(risk) ||
    risk.payerAddress !== payerAddress ||
    !validStateIdentity ||
    !validTimes ||
    typeof risk.paymentConfirmed !== 'boolean' ||
    (risk.chainStatus !== undefined &&
      !['unknown', 'observed', 'included', 'solidified'].includes(risk.chainStatus)) ||
    (risk.chainExecution !== undefined &&
      !['unknown', 'success', 'failed'].includes(risk.chainExecution)) ||
    (risk.networkFingerprint !== undefined &&
      (typeof risk.networkFingerprint !== 'string' || risk.networkFingerprint.length === 0)) ||
    (risk.state !== undefined && !['preparing', 'signed'].includes(risk.state))
  ) {
    throw riskStoreError('Energy payment risk storage contains an invalid record.');
  }
  return risk;
}

function createIntentId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // Fail closed below instead of using Math.random for a payment intent key.
  }
  throw new EnergyPurchaseError('CONFIG_MISSING', 'A cryptographically secure random source is required.');
}

function riskKey(payerAddress) {
  return `${PAYMENT_RISK_PREFIX}${encodeURIComponent(payerAddress)}`;
}

function readRisks(storage, payerAddress) {
  requireRiskStorage(storage);
  let raw;
  try {
    raw = storage.getItem(riskKey(payerAddress));
  } catch (cause) {
    throw riskStoreError('Energy payment risk storage could not be read.', cause);
  }
  if (raw === null) return [];
  try {
    const value = JSON.parse(raw);
    const risks = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : null;
    if (!risks) throw new Error('expected an array or object');
    const containedReplayablePayload = risks.some(
      risk => risk && typeof risk === 'object' && Object.prototype.hasOwnProperty.call(risk, 'signedRequest')
    );
    const safeRisks = risks.map(risk => assertRiskRecord(metadataOnlyRisk(risk), payerAddress));
    // Migrate legacy records in place on first read so an old signed body does
    // not remain recoverable from localStorage after upgrading the SDK.
    if (containedReplayablePayload) {
      storage.setItem(riskKey(payerAddress), JSON.stringify(safeRisks));
    }
    return safeRisks;
  } catch (cause) {
    if (cause instanceof EnergyPurchaseError) throw cause;
    throw riskStoreError('Energy payment risk storage is corrupt or has an invalid schema.', cause);
  }
}

function writeRisk(storage, risk) {
  requireRiskStorage(storage);
  const safeRisk = metadataOnlyRisk(risk);
  assertRiskRecord(safeRisk, safeRisk.payerAddress);
  const risks = readRisks(storage, safeRisk.payerAddress);
  const sameRisk = item =>
    (safeRisk.intentId && item.intentId === safeRisk.intentId) ||
    (safeRisk.signedTxId && item.signedTxId === safeRisk.signedTxId);
  const next = risks.filter(item => !sameRisk(item));
  next.push(safeRisk);
  try {
    storage.setItem(riskKey(safeRisk.payerAddress), JSON.stringify(next));
  } catch (cause) {
    throw riskStoreError('Energy payment risk storage could not be written.', cause);
  }
  return safeRisk;
}

function clearRisk(storage, payerAddress, riskId) {
  requireRiskStorage(storage);
  try {
    const risks = readRisks(storage, payerAddress);
    const removed = riskId
      ? risks.filter(risk => risk.signedTxId === riskId || risk.intentId === riskId)
      : risks;
    if (!riskId) {
      storage.removeItem(riskKey(payerAddress));
      return removed;
    }
    const remaining = risks.filter(
      risk => risk.signedTxId !== riskId && risk.intentId !== riskId
    );
    if (remaining.length) storage.setItem(riskKey(payerAddress), JSON.stringify(remaining));
    else storage.removeItem(riskKey(payerAddress));
    return removed;
  } catch (cause) {
    if (cause instanceof EnergyPurchaseError) throw cause;
    throw riskStoreError('Energy payment risk storage could not be updated.', cause);
  }
}

function readRisk(storage, payerAddress) {
  const risks = readRisks(storage, payerAddress);
  return risks.find(risk => risk.paymentConfirmed === true) || risks[0] || null;
}

async function withPayerPurchaseLock(payerAddress, paymentLock, task) {
  if (activePayerPurchases.has(payerAddress)) {
    throw new EnergyPurchaseError(
      'PURCHASE_IN_PROGRESS',
      'Another energy purchase is already in progress for this payer.'
    );
  }
  if (!paymentLock || typeof paymentLock.tryRunExclusive !== 'function') {
    throw new EnergyPurchaseError(
      'PAYMENT_LOCK_UNAVAILABLE',
      'Energy purchase requires a non-waiting cross-context payment lock. Use Web Locks or provide paymentLock.tryRunExclusive().'
    );
  }
  activePayerPurchases.add(payerAddress);
  try {
    let entered = false;
    const result = await paymentLock.tryRunExclusive(`${PAYMENT_LOCK_PREFIX}${payerAddress}`, async () => {
      entered = true;
      return task();
    });
    if (!entered) {
      throw new EnergyPurchaseError(
        'PURCHASE_IN_PROGRESS',
        'Another energy purchase is already in progress for this payer.'
      );
    }
    return result;
  } catch (cause) {
    if (cause instanceof EnergyPurchaseError) throw cause;
    throw new EnergyPurchaseError('PAYMENT_LOCK_FAILED', 'The payer payment lock failed.', { cause });
  } finally {
    activePayerPurchases.delete(payerAddress);
  }
}

function normalizeSignedTransaction(signedTransaction) {
  const signed = signedTransaction?.signedTransaction || signedTransaction;
  if (
    !signed ||
    typeof signed !== 'object' ||
    typeof signed.txID !== 'string' ||
    typeof signed.raw_data_hex !== 'string' ||
    !signed.raw_data ||
    !Array.isArray(signed.signature) ||
    signed.signature.length !== 1
  ) {
    throw new EnergyPurchaseError(
      'INVALID_SIGNED_TX',
      'Signer must return one signed TRX TransferContract transaction with txID, raw_data_hex, raw_data, and one signature.'
    );
  }
  return signed;
}

function assertSignedTransactionMatches(unsigned, signed) {
  if (
    normalizeHex(signed.txID) !== normalizeHex(unsigned.txID) ||
    normalizeHex(signed.raw_data_hex) !== normalizeHex(unsigned.raw_data_hex)
  ) {
    throw new EnergyPurchaseError(
      'SIGNED_TX_MISMATCH',
      'Signer returned a transaction that does not match the confirmed payer, recipient, amount, and request memo.'
    );
  }
}

function signedTransactionForWire(signed) {
  return {
    txID: normalizeHex(signed.txID),
    raw_data_hex: normalizeHex(signed.raw_data_hex),
    signature: [...signed.signature],
    visible: signed.visible === true
  };
}

function shouldClearSignedRisk(error) {
  return error instanceof EnergyPurchaseError &&
    error.isBusinessError &&
    Number(error.status) >= 400 &&
    Number(error.status) < 500 &&
    DETERMINISTIC_PRE_BROADCAST_CODES.has(error.code);
}

function createAbortSignal(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * Create a fail-closed client for the JustLend energy direct-purchase API.
 * The API URL is always explicit and payment transactions are signed locally but never broadcast by this client.
 */
export function createEnergyPurchaseClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl, options.allowInsecureLocalhost);
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new EnergyPurchaseError('CONFIG_MISSING', 'A Fetch-compatible implementation is required.');
  }
  const tronWeb = options.tronWeb;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const paymentLock = options.paymentLock ||
    (typeof storage?.tryRunExclusive === 'function' ? storage : defaultPaymentLock());
  const requestTimeoutMs = options.requestTimeoutMs ?? 8000;
  const paymentRetryIntervalMs = options.paymentRetryIntervalMs ?? 5000;
  const paymentRetryTimeoutMs = options.paymentRetryTimeoutMs ?? DEFAULT_PAYMENT_RETRY_MS;
  const orderPollIntervalMs = options.orderPollIntervalMs ?? 3000;
  const orderPollTimeoutMs = options.orderPollTimeoutMs ?? 150000;
  const orderTtlMs = options.orderTtlMs ?? DEFAULT_ORDER_TTL_MS;
  const sleep = options.sleep || sleepDefault;
  const now = options.now || Date.now;
  const explicitNetworkFingerprint = typeof options.networkFingerprint === 'string'
    ? options.networkFingerprint.trim()
    : '';
  // Full signed requests are deliberately short-lived and process-local. Only
  // non-replayable metadata is persisted through `storage`.
  const signedRequests = new Map();

  function replayKey(risk) {
    return risk?.intentId || risk?.signedTxId || '';
  }

  function rememberSignedRequest(risk, signedRequest) {
    const key = replayKey(risk);
    if (!key) throw new EnergyPurchaseError('INVALID_PAYMENT_INTENT', 'Signed payment risk is missing a recovery key.');
    signedRequests.set(key, signedRequest);
  }

  function forgetSignedRequests(risks) {
    for (const risk of risks || []) {
      const key = replayKey(risk);
      if (key) signedRequests.delete(key);
    }
  }

  function clearStoredRisk(payerAddress, riskId) {
    const removed = clearRisk(storage, payerAddress, riskId);
    forgetSignedRequests(removed);
    return removed;
  }

  function publicRisk(risk) {
    const metadata = metadataOnlyRisk(risk);
    return { ...metadata, replayAvailable: signedRequests.has(replayKey(metadata)) };
  }

  function assertCurrentPayer(payerAddress) {
    const configured = typeof options.getCurrentPayerAddress === 'function'
      ? options.getCurrentPayerAddress()
      : options.payerAddress || tronWeb?.defaultAddress?.base58;
    if (configured && typeof configured.then === 'function') {
      throw new EnergyPurchaseError(
        'PAYER_BINDING_REQUIRED',
        'getCurrentPayerAddress must return the active wallet address synchronously.'
      );
    }
    if (typeof configured !== 'string' || !configured) {
      throw new EnergyPurchaseError(
        'PAYER_BINDING_REQUIRED',
        'Energy payment recovery requires a current wallet binding via tronWeb.defaultAddress.base58, payerAddress, or getCurrentPayerAddress.'
      );
    }
    validateAddress(configured, 'current wallet address');
    if (configured !== payerAddress) {
      throw new EnergyPurchaseError(
        'PAYER_MISMATCH',
        'The requested payer does not match the current wallet session.'
      );
    }
    return configured;
  }

  // Browser upgrades scrub a legacy signedRequest as soon as the client can
  // identify the active payer, rather than waiting for an explicit risk call.
  const initialPayer = options.payerAddress || tronWeb?.defaultAddress?.base58;
  if (
    typeof initialPayer === 'string' && initialPayer &&
    storage && typeof storage.getItem === 'function' &&
    typeof storage.setItem === 'function' && typeof storage.removeItem === 'function'
  ) {
    validateAddress(initialPayer, 'current wallet address');
    readRisks(storage, initialPayer);
  }

  function currentNetworkFingerprint() {
    const provider = explicitNetworkFingerprint || rpcFingerprint(tronWeb);
    return provider ? `api=${baseUrl};provider=${provider}` : '';
  }

  function requireNetworkFingerprint() {
    const fingerprint = currentNetworkFingerprint();
    if (!fingerprint) {
      throw new EnergyPurchaseError(
        'NETWORK_FINGERPRINT_REQUIRED',
        'Energy purchase requires networkFingerprint or a tronWeb client with fixed provider hosts.'
      );
    }
    return fingerprint;
  }

  async function request(method, path, requestOptions = {}) {
    const { signal, cleanup } = createAbortSignal(requestOptions.timeoutMs ?? requestTimeoutMs, requestOptions.signal);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        redirect: 'error',
        headers: {
          ...(requestOptions.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(requestOptions.token ? { 'X-Consumer-Order-Token': requestOptions.token } : {})
        },
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
        signal
      });
    } catch (cause) {
      throw new EnergyPurchaseError('NETWORK_ERROR', 'Energy purchase API request did not return a response.', {
        retryable: true,
        cause
      });
    } finally {
      cleanup();
    }

    let envelope;
    try {
      envelope = await response.json();
    } catch (cause) {
      throw new EnergyPurchaseError('INVALID_RESPONSE', 'Energy purchase API returned a non-JSON response.', {
        status: response.status,
        retryable: response.status >= 500,
        cause
      });
    }
    if (!response.ok) {
      const code = typeof envelope?.code === 'string' && envelope.code.length > 0
        ? envelope.code.toUpperCase()
        : 'HTTP_ERROR';
      throw new EnergyPurchaseError(code, envelope?.msg || `Energy purchase API returned HTTP ${response.status}.`, {
        status: response.status,
        isBusinessError: response.status >= 400 && response.status < 500 && code !== 'HTTP_ERROR',
        retryable: response.status >= 500
      });
    }
    if (envelope?.code !== '0') {
      const businessCode = typeof envelope?.code === 'string' && envelope.code.length > 0;
      throw new EnergyPurchaseError(businessCode ? envelope.code.toUpperCase() : 'INVALID_RESPONSE', envelope?.msg, {
        status: response.status,
        isBusinessError: businessCode
      });
    }
    return envelope.data;
  }

  const getConfig = requestOptions => request('GET', ENERGY_PURCHASE_PATHS.config, requestOptions);
  const getCurrentPrice = requestOptions => request('GET', ENERGY_PURCHASE_PATHS.currentPrice, requestOptions);
  const getPoolHealth = requestOptions => request('GET', ENERGY_PURCHASE_PATHS.poolHealth, requestOptions);

  async function quote(input, requestOptions) {
    const config = input.config || (await getConfig(requestOptions));
    validateQuoteInput(input, config);
    const result = await request('POST', ENERGY_PURCHASE_PATHS.quote, {
      ...requestOptions,
      body: { receivers: input.receivers, quantity: input.energyPerReceiver, duration: input.duration }
    });
    if (
      !result ||
      !Number.isSafeInteger(Number(result.total_sun)) ||
      Number(result.total_sun) <= 0
    ) {
      throw new EnergyPurchaseError('INVALID_RESPONSE', 'Energy purchase quote is missing required fields.');
    }
    return { ...result, payment_address: config.payment_address };
  }

  async function getOrder(orderId, requestOptions = {}) {
    if (orderId === undefined || orderId === null || String(orderId).length === 0) {
      throw new EnergyPurchaseError('INVALID_ORDER_ID', 'orderId is required.');
    }
    return request('GET', ENERGY_PURCHASE_PATHS.order(orderId), requestOptions);
  }

  async function getHistory(address, historyOptions = {}) {
    void address;
    void historyOptions;
    throw new EnergyPurchaseError(
      'UNSUPPORTED_OPERATION',
      'The authoritative energy API has no order-history endpoint; persist the returned order ID and access token.'
    );
  }

  async function buildAndSignPayment({ payerAddress, payAddress, amountSun, receivers, energyPerReceiver, duration, signTransaction }) {
    if (!tronWeb?.transactionBuilder?.sendTrx) {
      throw new EnergyPurchaseError('CONFIG_MISSING', 'tronWeb with transactionBuilder.sendTrx is required for signing.');
    }
    if (typeof signTransaction !== 'function') {
      throw new EnergyPurchaseError('CONFIG_MISSING', 'signTransaction callback is required.');
    }
    validateAddress(payerAddress, 'payerAddress');
    assertCurrentPayer(payerAddress);
    validateAddress(payAddress, 'payAddress');
    validatePositiveInteger(Number(amountSun), 'amountSun');
    validatePositiveInteger(Number(energyPerReceiver), 'energyPerReceiver');
    if (!Array.isArray(receivers) || receivers.length === 0 || typeof duration !== 'string' || !duration) {
      throw new EnergyPurchaseError('INVALID_PAYMENT_INTENT', 'receivers and duration are required to bind the payment memo.');
    }
    let unsigned = await tronWeb.transactionBuilder.sendTrx(payAddress, Number(amountSun), payerAddress);
    if (unsigned?.raw_data?.expiration && tronWeb.transactionBuilder.extendExpiration) {
      const extensionSeconds = Math.ceil((now() + orderTtlMs - Number(unsigned.raw_data.expiration)) / 1000);
      if (extensionSeconds > 0) {
        try {
          const candidate = { ...unsigned, raw_data: { ...unsigned.raw_data } };
          unsigned = await tronWeb.transactionBuilder.extendExpiration(candidate, extensionSeconds, { txLocal: true });
        } catch {
          // The node-provided expiration is a shorter, safe fallback.
        }
      }
    }
    const memo = await consumerBuyMemo(receivers, Number(energyPerReceiver), duration);
    unsigned = attachMemo(tronWeb, unsigned, memo);
    const signed = normalizeSignedTransaction(
      await signTransaction(unsigned, {
        description: `Pay ${Number(amountSun) / 1e6} TRX for JustLend energy. Sign only; the service broadcasts.`
      })
    );
    assertSignedTransactionMatches(unsigned, signed);
    return signed;
  }

  async function lookupTransaction(txId) {
    if (!txId) return { status: 'unavailable', execution: 'unknown' };
    const trx = tronWeb?.trx;
    let attempted = 0;
    let unavailable = false;
    let included = null;

    if (typeof trx?.getUnconfirmedTransactionInfo === 'function') {
      attempted += 1;
      try {
        const info = await trx.getUnconfirmedTransactionInfo(txId);
        if (hasTransactionInfo(info, txId)) {
          included = { status: 'included', execution: transactionExecution(info) };
        }
      } catch (error) {
        if (!isTransactionNotFound(error)) unavailable = true;
      }
    }

    if (typeof trx?.getTransactionInfo === 'function') {
      attempted += 1;
      try {
        const info = await trx.getTransactionInfo(txId);
        if (hasTransactionInfo(info, txId)) {
          return { status: 'solidified', execution: transactionExecution(info) };
        }
      } catch (error) {
        if (!isTransactionNotFound(error)) unavailable = true;
      }
    }

    if (included) return included;

    if (typeof trx?.getTransaction === 'function') {
      attempted += 1;
      try {
        const transaction = await trx.getTransaction(txId);
        if (normalizeHex(transaction?.txID) === normalizeHex(txId)) {
          const execution = transactionExecution(transaction);
          return { status: execution === 'unknown' ? 'observed' : 'included', execution };
        }
      } catch (error) {
        if (!isTransactionNotFound(error)) unavailable = true;
      }
    }

    return { status: attempted === 0 || unavailable ? 'unavailable' : 'not_found', execution: 'unknown' };
  }

  function recordChainLookup(risk, lookup) {
    if (!['observed', 'included', 'solidified'].includes(lookup.status)) return;
    const rank = { unknown: 0, observed: 1, included: 2, solidified: 3 };
    if (rank[lookup.status] < rank[risk.chainStatus || 'unknown']) return;
    risk.chainStatus = lookup.status;
    if (lookup.execution !== 'unknown' || !risk.chainExecution) risk.chainExecution = lookup.execution;
    if (lookup.status === 'solidified' && lookup.execution === 'success') {
      risk.paymentConfirmed = true;
    }
    writeRisk(storage, risk);
  }

  async function reconcilePaymentRisksUnlocked(payerAddress, reconcileOptions = {}) {
    validateAddress(payerAddress, 'payerAddress');
    const risks = readRisks(storage, payerAddress);
    const fingerprint = currentNetworkFingerprint();
    const confirmReplay = reconcileOptions.confirmReplay === true;
    for (const risk of risks) {
      // Legacy/preparing records deliberately stay blocked: they do not contain
      // enough immutable evidence to prove that no signature escaped.
      if (!risk.signedTxId || !risk.networkFingerprint) {
        continue;
      }
      if (!fingerprint || risk.networkFingerprint !== fingerprint) continue;
      const signedRequest = signedRequests.get(replayKey(risk));
      if (confirmReplay && signedRequest && risk.paymentConfirmed !== true) {
        try {
          const recoveredOrder = await request('POST', ENERGY_PURCHASE_PATHS.buy, { body: signedRequest });
          // Keep an accepted/recovered marker until the caller explicitly records
          // the returned order and clears it. Automatically clearing here would
          // let purchase() sign a second payment in the same invocation.
          risk.paymentConfirmed = true;
          risk.recoveredOrder = recoveredOrderMetadata(recoveredOrder);
          writeRisk(storage, risk);
          signedRequests.delete(replayKey(risk));
          continue;
        } catch (error) {
          if (error.code === 'TX_ALREADY_CLAIMED') {
            risk.paymentConfirmed = true;
            writeRisk(storage, risk);
            signedRequests.delete(replayKey(risk));
            continue;
          } else if (shouldClearSignedRisk(error)) {
            clearStoredRisk(payerAddress, risk.signedTxId);
            continue;
          }
          // Ambiguous replay failures fall through to read-only chain evidence.
        }
      }

      const lookup = await lookupTransaction(risk.signedTxId);
      if (lookup.status === 'solidified' && lookup.execution === 'failed' && !risk.paymentConfirmed) {
        clearStoredRisk(payerAddress, risk.signedTxId);
      } else {
        recordChainLookup(risk, lookup);
      }
    }
    return readRisks(storage, payerAddress);
  }

  async function pollOrder(orderId, pollOptions = {}) {
    const deadline = now() + (pollOptions.timeoutMs ?? orderPollTimeoutMs);
    let detail = null;
    while (now() < deadline) {
      try {
        detail = await getOrder(orderId, { token: pollOptions.token, signal: pollOptions.signal });
        pollOptions.onState?.(detail?.state, detail);
        if (ENERGY_PURCHASE_TERMINAL_STATES.includes(detail?.state)) return detail;
      } catch (error) {
        if (pollOptions.signal?.aborted) {
          throw new EnergyPurchaseError('ABORTED', 'Energy purchase order polling was aborted.', { cause: error });
        }
        // Payment is already accepted; tolerate transient order-query failures until the deadline.
      }
      await sleep(orderPollIntervalMs);
    }
    return detail;
  }

  async function purchaseLocked(input) {
    validateAddress(input.payerAddress, 'payerAddress');
    assertCurrentPayer(input.payerAddress);
    const risksBeforeReconciliation = readRisks(storage, input.payerAddress);
    // Starting a new purchase only performs read-only chain reconciliation.
    // Replaying an older signed body requires the caller to invoke the explicit
    // recovery API with confirmReplay=true.
    const reconciledRisks = await reconcilePaymentRisksUnlocked(input.payerAddress);
    const previousRisk = reconciledRisks.find(risk => risk.paymentConfirmed === true) || reconciledRisks[0] || null;
    if (risksBeforeReconciliation.length || previousRisk) {
      throw new EnergyPurchaseError(
        'PAYMENT_RISK_UNRESOLVED',
        previousRisk?.chainStatus === 'included' || previousRisk?.chainStatus === 'observed'
          ? 'A previous payment is visible on FullNode but is not solidified. Do not sign another payment.'
          : previousRisk?.paymentConfirmed
            ? 'A previous payment was recovered or solidified. Record its order result and clear the risk explicitly before another purchase.'
            : 'A previous payment has an unknown result. Reconcile it before signing another payment.',
        { paymentRisk: previousRisk || risksBeforeReconciliation[0] }
      );
    }

    input.onState?.('quoting');
    const config = input.config || (await getConfig({ signal: input.signal }));
    const durations = Array.isArray(config?.supported_durations)
      ? config.supported_durations.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim())
      : [];
    if (typeof input.duration !== 'string' || !durations.includes(input.duration)) {
      throw new EnergyPurchaseError(
        'INVALID_DURATION',
        'duration must be explicitly selected from the live /v1/config supported_durations list.'
      );
    }
    const authoritativeQuote = await quote({ ...input, config }, { signal: input.signal });
    if (input.expectedAmountSun === undefined) {
      throw new EnergyPurchaseError(
        'CONFIRMATION_REQUIRED',
        'expectedAmountSun is required and must match the authoritative quote exactly.'
      );
    }
    validatePositiveInteger(Number(input.expectedAmountSun), 'expectedAmountSun');
    if (Number(authoritativeQuote.total_sun) !== Number(input.expectedAmountSun)) {
      throw new EnergyPurchaseError('AMOUNT_CHANGED', 'The authoritative quote differs from the confirmed amount.', {
        details: { amountSun: authoritativeQuote.total_sun, expectedAmountSun: input.expectedAmountSun }
      });
    }
    if (typeof input.expectedPayAddress !== 'string') {
      throw new EnergyPurchaseError(
        'CONFIRMATION_REQUIRED',
        'expectedPayAddress is required and must match the live configuration exactly.'
      );
    }
    validateAddress(input.expectedPayAddress, 'expectedPayAddress');
    if (authoritativeQuote.payment_address !== input.expectedPayAddress) {
      throw new EnergyPurchaseError('PAYMENT_ADDRESS_CHANGED', 'The configured payment address differs from the confirmed address.');
    }
    const networkFingerprint = requireNetworkFingerprint();

    // Persist an intent before asking the wallet to sign. A crash or tab/process
    // exit can therefore never turn an in-flight signing decision back into
    // "no payment risk" on restart.
    const intent = {
      payerAddress: input.payerAddress,
      intentId: createIntentId(),
      state: 'preparing',
      createdAt: now(),
      expiresAt: now() + DEFAULT_PURCHASE_INTENT_TTL_MS,
      paymentConfirmed: false,
      chainStatus: 'unknown',
      chainExecution: 'unknown',
      networkFingerprint
    };
    writeRisk(storage, intent);

    input.onState?.('signing');
    let signed;
    try {
      signed = await buildAndSignPayment({
        payerAddress: input.payerAddress,
        payAddress: authoritativeQuote.payment_address,
        amountSun: Number(authoritativeQuote.total_sun),
        receivers: input.receivers,
        energyPerReceiver: input.energyPerReceiver,
        duration: input.duration,
        signTransaction: input.signTransaction
      });
    } catch (error) {
      throw new EnergyPurchaseError(
        'SIGNING_RESULT_UNKNOWN',
        'The wallet signing result is unknown. The payment intent remains blocked until it is resolved explicitly.',
        { paymentRisk: intent, cause: error }
      );
    }
    const signedExpiration = Number(signed.raw_data?.expiration);
    const signedDeadline = Number.isFinite(signedExpiration) ? signedExpiration : now() + orderTtlMs;
    const retryDeadline = Math.min(signedDeadline, now() + paymentRetryTimeoutMs);
    const signedRequest = {
      receivers: [...input.receivers],
      energy: input.energyPerReceiver,
      duration: input.duration,
      payer_address: input.payerAddress,
      signed_transaction: signedTransactionForWire(signed)
    };
    const txId = signedRequest.signed_transaction.txID;
    const risk = {
      ...intent,
      signedTxId: txId,
      state: 'signed',
      expiresAt: signedDeadline
    };
    rememberSignedRequest(risk, signedRequest);
    writeRisk(storage, risk);

    input.onState?.('submitting');
    let order;
    while (!order) {
      if (input.signal?.aborted) throw new EnergyPurchaseError('ABORTED', 'Energy purchase was aborted.');
      writeRisk(storage, risk);
      try {
        order = await request('POST', ENERGY_PURCHASE_PATHS.buy, {
          body: signedRequest,
          signal: input.signal
        });
      } catch (error) {
        if (error.isBusinessError) {
          if (error.code === 'TX_ALREADY_CLAIMED') {
            risk.paymentConfirmed = true;
            writeRisk(storage, risk);
            error.paymentRisk = risk;
          } else if (shouldClearSignedRisk(error)) {
            clearStoredRisk(input.payerAddress, txId);
          }
          throw error;
        }
        if (now() >= retryDeadline) {
          const lookup = await lookupTransaction(txId);
          if (['observed', 'included', 'solidified'].includes(lookup.status)) {
            if (lookup.status === 'solidified' && lookup.execution === 'failed') {
              clearStoredRisk(input.payerAddress, txId);
              throw new EnergyPurchaseError(
                'PAYMENT_FAILED_ON_CHAIN',
                'The signed payment failed in a solidified block and was not accepted as payment.',
                {
                  retryable: false,
                  cause: error,
                  details: { txId, chainStatus: lookup.status, chainExecution: lookup.execution }
                }
              );
            }
            recordChainLookup(risk, lookup);
            if (lookup.execution === 'failed') {
              throw new EnergyPurchaseError(
                'PAYMENT_RESULT_UNKNOWN',
                'FullNode reports a failed execution, but the block is not solidified. Do not sign another payment yet.',
                { retryable: false, paymentRisk: risk, cause: error }
              );
            }
            return {
              ok: true,
              orderId: null,
              txHash: txId,
              state: 'pending',
              observedOnChain: true,
              confirmedOnChain: lookup.status === 'solidified',
              chainStatus: lookup.status,
              chainExecution: lookup.execution,
              paymentRisk: risk
            };
          }
          throw new EnergyPurchaseError(
            'PAYMENT_RESULT_UNKNOWN',
            'The same signed payment could not be reconciled; do not create another payment silently.',
            { retryable: false, paymentRisk: risk, cause: error }
          );
        }
        await sleep(paymentRetryIntervalMs);
      }
    }

    const batch = order?.batch;
    const payment = order?.payment;
    if (!batch || typeof batch.id !== 'string' || typeof batch.access_token !== 'string') {
      throw new EnergyPurchaseError(
        'INVALID_RESPONSE',
        'Energy purchase response is missing batch or access token.',
        { paymentRisk: risk }
      );
    }
    const orderId = batch.id;
    const txHash = payment?.tx_hash || txId;
    // An HTTP success means the service may have accepted and broadcast the
    // signed payment. Commit that fact before exposing the order result: a
    // crash, malformed response, or callback failure must never erase the
    // durable marker and permit another signature.
    risk.paymentConfirmed = true;
    risk.recoveredOrder = recoveredOrderMetadata(order);
    writeRisk(storage, risk);
    signedRequests.delete(replayKey(risk));
    input.onOrderAccepted?.({ orderId, txHash, state: batch.state || 'pending' });
    input.onState?.('delivering');
    const detail = await pollOrder(orderId, {
      token: batch.access_token,
      signal: input.signal,
      onState: input.onOrderState
    });
    const state = detail?.state || batch.state || 'pending';
    if (state === 'failed' || state === 'expired') {
      throw new EnergyPurchaseError('DELIVERY_FAILED', 'Payment was accepted but energy delivery failed.', {
        details: { orderId, txHash, state, detail },
        paymentRisk: risk
      });
    }
    return { ok: true, orderId, txHash, state, detail, paymentRisk: publicRisk(risk) };
  }

  async function purchase(input) {
    validateAddress(input?.payerAddress, 'payerAddress');
    assertCurrentPayer(input.payerAddress);
    requireRiskStorage(storage);
    return withPayerPurchaseLock(input.payerAddress, paymentLock, () => purchaseLocked(input));
  }

  async function reconcilePaymentRisks(payerAddress, reconcileOptions = {}) {
    validateAddress(payerAddress, 'payerAddress');
    assertCurrentPayer(payerAddress);
    requireRiskStorage(storage);
    const risks = await withPayerPurchaseLock(
      payerAddress,
      paymentLock,
      () => reconcilePaymentRisksUnlocked(payerAddress, reconcileOptions)
    );
    return risks.map(publicRisk);
  }

  async function clearPaymentRisk(payerAddress, riskId) {
    validateAddress(payerAddress, 'payerAddress');
    assertCurrentPayer(payerAddress);
    requireRiskStorage(storage);
    return withPayerPurchaseLock(payerAddress, paymentLock, () => {
      const risks = readRisks(storage, payerAddress);
      const targets = riskId
        ? risks.filter(risk => risk.intentId === riskId || risk.signedTxId === riskId)
        : risks;
      if (!targets.length) return;
      if (targets.some(risk => risk.paymentConfirmed !== true)) {
        throw new EnergyPurchaseError(
          'MANUAL_RESOLUTION_REQUIRED',
          'Only a payment accepted by exact /buy replay or proven solidified can be cleared automatically; unresolved risks require operator recovery.'
        );
      }
      clearStoredRisk(payerAddress, riskId);
    });
  }

  return Object.freeze({
    baseUrl,
    getConfig,
    getCurrentPrice,
    getPoolHealth,
    quote,
    getOrder,
    getHistory,
    buildAndSignPayment,
    pollOrder,
    purchase,
    getPaymentRisk: payerAddress => {
      validateAddress(payerAddress, 'payerAddress');
      assertCurrentPayer(payerAddress);
      const risk = readRisk(storage, payerAddress);
      return risk ? publicRisk(risk) : null;
    },
    getPaymentRisks: payerAddress => {
      validateAddress(payerAddress, 'payerAddress');
      assertCurrentPayer(payerAddress);
      return readRisks(storage, payerAddress).map(publicRisk);
    },
    reconcilePaymentRisks,
    clearPaymentRisk
  });
}
