import { describe, expect, it, vi } from 'vitest';
import { createEnergyPurchaseClient, EnergyPurchaseError, ENERGY_PURCHASE_PATHS } from '../utils/energyPurchase';

const PAYER = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';
const RECEIVER = 'TVjsyZ7fYF3qLF6BQgPmTEZy1xrNNyVAAA';
const PAY_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const TX_ID = 'ab'.repeat(32);
const RAW_HEX = 'cd'.repeat(16);

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
const envelope = data => response({ code: '0', msg: 'ok', data });
const config = () => ({
  min_energy: 65000,
  max_energy: 5000000,
  max_batch_receivers: 50,
  supported_durations: ['1h'],
  energy_presets: [65000, 131000],
  payment_address: PAY_ADDRESS,
  activation_fee_sun: 1100000
});
const quote = () => ({ total_sun: 2405000, total_trx: '2.405', receiver_count: 1 });
const accepted = id => ({
  batch: { id: String(id), access_token: 'secret-token', state: 'paid' },
  payment: { tx_hash: TX_ID }
});

function memoryStorage() {
  const values = new Map();
  const locks = new Set();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    async tryRunExclusive(key, task) {
      if (locks.has(key)) throw new EnergyPurchaseError('PURCHASE_IN_PROGRESS', 'purchase already in progress');
      locks.add(key);
      try { return await task(); } finally { locks.delete(key); }
    }
  };
}

function signingHarness() {
  const unsigned = {
    txID: 'unsigned-id',
    raw_data: { expiration: 1000, contract: [{ type: 'TransferContract' }] },
    raw_data_hex: '00'
  };
  const extended = { ...unsigned, raw_data: { ...unsigned.raw_data, expiration: 300001 } };
  const transactionUtils = {
    txJsonToPb: vi.fn(transaction => transaction),
    txPbToRawDataHex: vi.fn(() => RAW_HEX),
    txPbToTxID: vi.fn(() => TX_ID)
  };
  const tronWeb = {
    fullNode: { host: 'https://api.trongrid.io' },
    utils: { transaction: transactionUtils },
    transactionBuilder: {
      sendTrx: vi.fn(async () => unsigned),
      extendExpiration: vi.fn(async () => extended)
    },
    trx: { getTransaction: vi.fn(async () => null) }
  };
  const signTransaction = vi.fn(async transaction => ({ ...transaction, signature: ['aa'] }));
  return { tronWeb, signTransaction, transactionUtils };
}

function purchaseInput(signTransaction, overrides = {}) {
  return {
    payerAddress: PAYER,
    receivers: [RECEIVER],
    energyPerReceiver: 65000,
    duration: '1h',
    expectedAmountSun: 2405000,
    expectedPayAddress: PAY_ADDRESS,
    signTransaction,
    ...overrides
  };
}

function clientOptions(tronWeb, fetch, storage = memoryStorage()) {
  return {
    baseUrl: 'https://energy.example.com', fetch, tronWeb, storage,
    sleep: async () => {}, now: () => 1
  };
}

describe('energy purchase client', () => {
  it('requires an explicit HTTPS API URL and has no production fallback', () => {
    expect(() => createEnergyPurchaseClient()).toThrowError(EnergyPurchaseError);
    expect(() => createEnergyPurchaseClient({ baseUrl: 'http://example.com' })).toThrow(/HTTPS/);
  });

  it('uses the authoritative config and price contract', async () => {
    const bodies = [];
    const fetch = vi.fn(async (url, options = {}) => {
      if (url.endsWith(ENERGY_PURCHASE_PATHS.config)) return envelope(config());
      if (url.endsWith(ENERGY_PURCHASE_PATHS.quote)) {
        bodies.push(JSON.parse(options.body));
        return envelope(quote());
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = createEnergyPurchaseClient({ baseUrl: 'https://energy.example.com', fetch });
    const value = await client.quote({ receivers: [RECEIVER], energyPerReceiver: 65000, duration: '1h' });
    expect(value).toMatchObject({ total_sun: 2405000, payment_address: PAY_ADDRESS });
    expect(bodies).toEqual([{ receivers: [RECEIVER], quantity: 65000, duration: '1h' }]);
  });

  it('adds the request-bound memo and rejects signer substitution', async () => {
    const { tronWeb, signTransaction, transactionUtils } = signingHarness();
    const client = createEnergyPurchaseClient({ baseUrl: 'https://energy.example.com', fetch: vi.fn(), tronWeb, now: () => 1 });
    const signed = await client.buildAndSignPayment({
      payerAddress: PAYER, payAddress: PAY_ADDRESS, amountSun: 2405000,
      receivers: [RECEIVER], energyPerReceiver: 65000, duration: '1h', signTransaction
    });
    expect(signed.txID).toBe(TX_ID);
    const payable = transactionUtils.txJsonToPb.mock.calls[0][0];
    expect(Buffer.from(payable.raw_data.data, 'hex').toString()).toMatch(/^a6-buy-v1:[0-9a-f]{64}$/);

    await expect(client.buildAndSignPayment({
      payerAddress: PAYER, payAddress: PAY_ADDRESS, amountSun: 2405000,
      receivers: [RECEIVER], energyPerReceiver: 65000, duration: '1h',
      signTransaction: async transaction => ({ ...transaction, txID: 'ef'.repeat(32), signature: ['aa'] })
    })).rejects.toMatchObject({ code: 'SIGNED_TX_MISMATCH' });
  });

  it('retries only the same signed request and consumes nested buy response', async () => {
    const { tronWeb, signTransaction } = signingHarness();
    let buyCalls = 0;
    const submitted = [];
    const fetch = vi.fn(async (url, options) => {
      if (url.endsWith(ENERGY_PURCHASE_PATHS.config)) return envelope(config());
      if (url.endsWith(ENERGY_PURCHASE_PATHS.quote)) return envelope(quote());
      if (url.endsWith(ENERGY_PURCHASE_PATHS.buy)) {
        const body = JSON.parse(options.body);
        submitted.push(body);
        if (++buyCalls === 1) throw new Error('connection reset');
        return envelope(accepted(7));
      }
      if (url.endsWith('/v1/consumer/energy/orders/7')) return envelope({ id: '7', state: 'delivered' });
      throw new Error(`unexpected ${url}`);
    });
    const client = createEnergyPurchaseClient(clientOptions(tronWeb, fetch));
    const result = await client.purchase(purchaseInput(signTransaction));
    expect(result).toMatchObject({ ok: true, orderId: '7', txHash: TX_ID, state: 'delivered' });
    expect(submitted).toHaveLength(2);
    expect(submitted[0]).toEqual(submitted[1]);
    expect(submitted[0]).toMatchObject({ energy: 65000, signed_transaction: { txID: TX_ID } });
    expect(submitted[0].signed_transaction).not.toHaveProperty('raw_data');
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(client.getPaymentRisk(PAYER)).toBeNull();
  });

  it('classifies 5xx as ambiguous and preserves a replayable risk', async () => {
    const { tronWeb, signTransaction } = signingHarness();
    const storage = memoryStorage();
    let now = 1;
    const fetch = vi.fn(async url => {
      if (url.endsWith(ENERGY_PURCHASE_PATHS.config)) return envelope(config());
      if (url.endsWith(ENERGY_PURCHASE_PATHS.quote)) return envelope(quote());
      if (url.endsWith(ENERGY_PURCHASE_PATHS.buy)) {
        now = 999999;
        return response({ code: 'wallet_rpc_error', msg: 'retry same transaction', data: null }, 502);
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = createEnergyPurchaseClient({
      ...clientOptions(tronWeb, fetch, storage), now: () => now,
      paymentRetryTimeoutMs: 1
    });
    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({ code: 'PAYMENT_RESULT_UNKNOWN' });
    expect(client.getPaymentRisk(PAYER)).toMatchObject({
      signedTxId: TX_ID,
      networkFingerprint: expect.stringContaining('api.trongrid.io'),
      signedRequest: { signed_transaction: { txID: TX_ID } }
    });
  });

  it('clears risk only for an allowlisted deterministic 4xx', async () => {
    const { tronWeb, signTransaction } = signingHarness();
    const storage = memoryStorage();
    const fetch = vi.fn(async url => {
      if (url.endsWith(ENERGY_PURCHASE_PATHS.config)) return envelope(config());
      if (url.endsWith(ENERGY_PURCHASE_PATHS.quote)) return envelope(quote());
      if (url.endsWith(ENERGY_PURCHASE_PATHS.buy)) return response({ code: 'price_moved', msg: 'changed' }, 409);
      throw new Error(`unexpected ${url}`);
    });
    const client = createEnergyPurchaseClient(clientOptions(tronWeb, fetch, storage));
    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({ code: 'PRICE_MOVED', isBusinessError: true });
    expect(client.getPaymentRisk(PAYER)).toBeNull();
  });

  it('pins the confirmed payment address before signing', async () => {
    const { tronWeb, signTransaction } = signingHarness();
    const fetch = vi.fn(async url => {
      if (url.endsWith(ENERGY_PURCHASE_PATHS.config)) return envelope(config());
      if (url.endsWith(ENERGY_PURCHASE_PATHS.quote)) return envelope(quote());
      throw new Error(`unexpected ${url}`);
    });
    const client = createEnergyPurchaseClient(clientOptions(tronWeb, fetch));
    await expect(client.purchase(purchaseInput(signTransaction, { expectedPayAddress: RECEIVER })))
      .rejects.toMatchObject({ code: 'PAYMENT_ADDRESS_CHANGED' });
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('does not reconcile a risk through a different network/provider', async () => {
    const { tronWeb } = signingHarness();
    const storage = memoryStorage();
    storage.setItem(`justlend_energy_purchase_risk:${encodeURIComponent(PAYER)}`, JSON.stringify([{
      payerAddress: PAYER, intentId: 'intent', signedTxId: TX_ID, state: 'signed', createdAt: 1,
      expiresAt: 2, paymentConfirmed: false, networkFingerprint: 'api=https://energy.example.com;provider=https://wrong.network',
      signedRequest: { receivers: [RECEIVER], energy: 65000, duration: '1h', payer_address: PAYER,
        signed_transaction: { txID: TX_ID, raw_data_hex: RAW_HEX, signature: ['aa'], visible: false } }
    }]));
    const fetch = vi.fn();
    const client = createEnergyPurchaseClient(clientOptions(tronWeb, fetch, storage));
    await expect(client.reconcilePaymentRisks(PAYER)).resolves.toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed for corrupt storage and unsupported history', async () => {
    const { tronWeb } = signingHarness();
    const storage = memoryStorage();
    storage.setItem(`justlend_energy_purchase_risk:${encodeURIComponent(PAYER)}`, '{bad json');
    const client = createEnergyPurchaseClient(clientOptions(tronWeb, vi.fn(), storage));
    expect(() => client.getPaymentRisks(PAYER)).toThrowError(expect.objectContaining({ code: 'RISK_STORE_UNAVAILABLE' }));
    await expect(client.getHistory(PAYER)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});
