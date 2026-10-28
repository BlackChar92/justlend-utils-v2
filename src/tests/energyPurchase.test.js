import { describe, expect, it, vi } from 'vitest';
import { createEnergyPurchaseClient, EnergyPurchaseError, ENERGY_PURCHASE_PATHS } from '../utils/energyPurchase';
import appFixture from './fixtures/energy-api-app-master.json';

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
    defaultAddress: { base58: PAYER },
    fullNode: { host: 'https://api.trongrid.io' },
    utils: { transaction: transactionUtils },
    transactionBuilder: {
      sendTrx: vi.fn(async () => unsigned),
      extendExpiration: vi.fn(async () => extended)
    },
    trx: {
      getUnconfirmedTransactionInfo: vi.fn(async () => ({})),
      getTransactionInfo: vi.fn(async () => ({})),
      getTransaction: vi.fn(async () => null)
    }
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
    const redirects = [];
    const fetch = vi.fn(async (url, options = {}) => {
      redirects.push(options.redirect);
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
    expect(bodies).toEqual([{ receivers: [RECEIVER], energy_per_receiver: 65000 }]);
    expect(redirects).toEqual(['error', 'error']);
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

  it('retries only the same signed request and retains an accepted-payment marker', async () => {
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
    expect(result).toMatchObject({
      ok: true,
      orderId: '7',
      txHash: TX_ID,
      state: 'delivered',
      paymentRisk: { paymentConfirmed: true, signedTxId: TX_ID }
    });
    expect(submitted).toHaveLength(2);
    expect(submitted[0]).toEqual(submitted[1]);
    expect(submitted[0]).toMatchObject({ energy_per_receiver: 65000, signed_transaction: { txID: TX_ID } });
    expect(submitted[0]).not.toHaveProperty('energy');
    expect(submitted[0].signed_transaction).not.toHaveProperty('raw_data');
    expect(signTransaction).toHaveBeenCalledTimes(1);
    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({
      code: 'PAYMENT_RISK_UNRESOLVED'
    });
    expect(signTransaction).toHaveBeenCalledTimes(1);
    await client.clearPaymentRisk(PAYER, result.paymentRisk.intentId);
    expect(client.getPaymentRisk(PAYER)).toBeNull();
  });

  it('preserves the signed-risk marker when a nominal buy response is malformed', async () => {
    const { tronWeb, signTransaction } = signingHarness();
    const storage = memoryStorage();
    const fetch = vi.fn(async url => {
      if (url.endsWith(ENERGY_PURCHASE_PATHS.config)) return envelope(config());
      if (url.endsWith(ENERGY_PURCHASE_PATHS.quote)) return envelope(quote());
      if (url.endsWith(ENERGY_PURCHASE_PATHS.buy)) return envelope({});
      throw new Error(`unexpected ${url}`);
    });
    const client = createEnergyPurchaseClient(clientOptions(tronWeb, fetch, storage));

    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      paymentRisk: { signedTxId: TX_ID, paymentConfirmed: false }
    });
    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({
      code: 'PAYMENT_RISK_UNRESOLVED'
    });
    expect(signTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(['acceptance callback', 'delivery callback', 'aborted polling', 'failed delivery'])(
    'retains accepted-payment risk after %s failure, including across client restarts',
    async failure => {
      const { tronWeb, signTransaction } = signingHarness();
      const storage = memoryStorage();
      const controller = new AbortController();
      const fetch = vi.fn(async url => {
        if (url.endsWith(ENERGY_PURCHASE_PATHS.config)) return envelope(config());
        if (url.endsWith(ENERGY_PURCHASE_PATHS.quote)) return envelope(quote());
        if (url.endsWith(ENERGY_PURCHASE_PATHS.buy)) return envelope(accepted('7'));
        if (url.includes(ENERGY_PURCHASE_PATHS.order('7'))) {
          if (failure === 'aborted polling') {
            controller.abort();
            throw new Error('poll aborted');
          }
          return envelope({ state: 'failed' });
        }
        throw new Error(`unexpected ${url}`);
      });
      const client = createEnergyPurchaseClient(clientOptions(tronWeb, fetch, storage));
      await expect(client.purchase(purchaseInput(signTransaction, {
        signal: controller.signal,
        onOrderAccepted: () => {
          if (failure === 'acceptance callback') throw new Error('cannot record order');
        },
        onState: state => {
          if (state === 'delivering' && failure === 'delivery callback') throw new Error('cannot update state');
        },
      }))).rejects.toThrow();

      const restarted = createEnergyPurchaseClient(clientOptions(tronWeb, fetch, storage));
      const risk = restarted.getPaymentRisk(PAYER);
      expect(risk).toMatchObject({ paymentConfirmed: true, signedTxId: TX_ID, recoveredOrder: { batch: { id: '7' } } });
      expect(JSON.stringify(risk)).not.toContain('secret-token');
      await expect(restarted.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({ code: 'PAYMENT_RISK_UNRESOLVED' });
      expect(signTransaction).toHaveBeenCalledTimes(1);
    },
  );

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
      replayAvailable: true
    });
    expect(client.getPaymentRisk(PAYER)).not.toHaveProperty('signedRequest');
    const persisted = storage.getItem(`justlend_energy_purchase_risk:${encodeURIComponent(PAYER)}`);
    expect(persisted).not.toContain(RAW_HEX);
    expect(persisted).not.toContain('signature');
  });

  it('replays only after explicit confirmation and only for the current wallet', async () => {
    const { tronWeb, signTransaction } = signingHarness();
    const storage = memoryStorage();
    let now = 1;
    let recoveryEnabled = false;
    let buyCalls = 0;
    const fetch = vi.fn(async url => {
      if (url.endsWith(ENERGY_PURCHASE_PATHS.config)) return envelope(config());
      if (url.endsWith(ENERGY_PURCHASE_PATHS.quote)) return envelope(quote());
      if (url.endsWith(ENERGY_PURCHASE_PATHS.buy)) {
        buyCalls += 1;
        if (!recoveryEnabled) {
          now = 999999;
          return response({ code: 'wallet_rpc_error', msg: 'retry same transaction', data: null }, 502);
        }
        return envelope(accepted(8));
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = createEnergyPurchaseClient({
      ...clientOptions(tronWeb, fetch, storage),
      now: () => now,
      paymentRetryTimeoutMs: 1
    });

    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({ code: 'PAYMENT_RESULT_UNKNOWN' });
    const callsAfterPurchase = buyCalls;
    await client.reconcilePaymentRisks(PAYER);
    expect(buyCalls).toBe(callsAfterPurchase);

    recoveryEnabled = true;
    const [recovered] = await client.reconcilePaymentRisks(PAYER, { confirmReplay: true });
    expect(buyCalls).toBe(callsAfterPurchase + 1);
    expect(recovered).toMatchObject({
      paymentConfirmed: true,
      replayAvailable: false,
      recoveredOrder: { batch: { id: '8', state: 'paid' } }
    });
    expect(recovered).not.toHaveProperty('signedRequest');
    expect(recovered.recoveredOrder.batch).not.toHaveProperty('access_token');
  });

  it('rejects payment-risk access for a payer outside the current wallet session', async () => {
    const { tronWeb } = signingHarness();
    const otherPayer = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
    const client = createEnergyPurchaseClient(clientOptions(tronWeb, vi.fn()));

    expect(() => client.getPaymentRisks(otherPayer)).toThrowError(expect.objectContaining({ code: 'PAYER_MISMATCH' }));
    await expect(client.reconcilePaymentRisks(otherPayer, { confirmReplay: true }))
      .rejects.toMatchObject({ code: 'PAYER_MISMATCH' });
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
    const migrated = storage.getItem(`justlend_energy_purchase_risk:${encodeURIComponent(PAYER)}`);
    expect(migrated).not.toContain(RAW_HEX);
    expect(migrated).not.toContain('signedRequest');
  });

  it('records FullNode inclusion before SolidityNode finality', async () => {
    const { tronWeb } = signingHarness();
    let solidified = false;
    tronWeb.trx.getUnconfirmedTransactionInfo.mockImplementation(async () => ({
      id: TX_ID,
      blockNumber: 100,
      receipt: { result: 'SUCCESS' }
    }));
    tronWeb.trx.getTransactionInfo.mockImplementation(async () => solidified ? {
      id: TX_ID,
      blockNumber: 100,
      receipt: { result: 'SUCCESS' }
    } : {});
    const storage = memoryStorage();
    storage.setItem(`justlend_energy_purchase_risk:${encodeURIComponent(PAYER)}`, JSON.stringify([{
      payerAddress: PAYER,
      intentId: 'intent',
      signedTxId: TX_ID,
      state: 'signed',
      createdAt: 1,
      expiresAt: 300001,
      paymentConfirmed: false,
      chainStatus: 'unknown',
      chainExecution: 'unknown',
      networkFingerprint: 'api=https://energy.example.com;provider=mainnet-provider',
      signedRequest: {
        receivers: [RECEIVER], energy: 65000, duration: '1h', payer_address: PAYER,
        signed_transaction: { txID: TX_ID, raw_data_hex: RAW_HEX, signature: ['aa'], visible: false }
      }
    }]));
    const fetch = vi.fn(async () => response({
      code: 'wallet_rpc_error', msg: 'retry the same transaction', data: null
    }, 502));
    const client = createEnergyPurchaseClient({
      ...clientOptions(tronWeb, fetch, storage),
      networkFingerprint: 'mainnet-provider'
    });

    await expect(client.reconcilePaymentRisks(PAYER)).resolves.toMatchObject([{
      paymentConfirmed: false,
      chainStatus: 'included',
      chainExecution: 'success'
    }]);

    solidified = true;
    await expect(client.reconcilePaymentRisks(PAYER)).resolves.toMatchObject([{
      paymentConfirmed: true,
      chainStatus: 'solidified',
      chainExecution: 'success'
    }]);
    expect(tronWeb.trx.getUnconfirmedTransactionInfo).toHaveBeenCalledTimes(2);
    expect(tronWeb.trx.getTransactionInfo).toHaveBeenCalledTimes(2);
  });

  it('fails closed for corrupt storage', async () => {
    const { tronWeb } = signingHarness();
    const storage = memoryStorage();
    storage.setItem(`justlend_energy_purchase_risk:${encodeURIComponent(PAYER)}`, '{bad json');
    expect(() => createEnergyPurchaseClient(clientOptions(tronWeb, vi.fn(), storage)))
      .toThrowError(expect.objectContaining({ code: 'RISK_STORE_UNAVAILABLE' }));
  });
});

// U1-U8: fixtures follow the pinned App API, not SDK implementation output.
describe('App master energy API compatibility', () => {
  const quoteInput = overrides => ({ receivers: [RECEIVER], energyPerReceiver: 65000, duration: '1h', ...overrides });
  function harness(overrides = {}, storage = memoryStorage()) {
    const signing = signingHarness();
    const fetch = vi.fn(async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/v1/config') return envelope(overrides.config ?? appFixture.config);
      if (path === '/v1/price') return envelope(overrides.quote ?? appFixture.quote);
      if (path === '/v1/consumer/energy/buy') return typeof overrides.buy === 'function'
        ? overrides.buy(options) : envelope(overrides.buy ?? appFixture.accepted);
      if (path === '/v1/consumer/energy/orders/history') return typeof overrides.history === 'function'
        ? overrides.history(url) : envelope(overrides.history ?? { rows: [], total: 0 });
      if (path.startsWith('/v1/consumer/energy/orders/')) return envelope(overrides.detail ?? { state: 'delivered' });
      throw new Error(`Unexpected offline URL ${url}`);
    });
    const client = createEnergyPurchaseClient({ ...clientOptions(signing.tronWeb, fetch, storage), ...overrides.options });
    return { ...signing, client, fetch, storage };
  }

  it('U1/U2 normalizes current config/quote and writes the App request contract', async () => {
    const { client, fetch, signTransaction } = harness();
    expect(await client.getConfig()).toMatchObject({ max_batch_receivers: 50, supported_durations: ['1h'], energy_presets: [65000, 131000] });
    expect(await client.quote(quoteInput())).toMatchObject({ total_sun: 2405000, payment_address: PAY_ADDRESS });
    const result = await client.purchase(purchaseInput(signTransaction));
    expect(result).toMatchObject({ orderId: '7', state: 'delivered', reconciliationRequired: false });
    const requests = fetch.mock.calls.map(([url, opts]) => [new URL(url).pathname, opts.body && JSON.parse(opts.body)]);
    expect(requests.find(([path]) => path === '/v1/price')[1]).toEqual({ receivers: [RECEIVER], energy_per_receiver: 65000 });
    expect(requests.find(([path]) => path.endsWith('/buy'))[1]).toMatchObject({ energy_per_receiver: 65000, duration: '1h', payer_address: PAYER });
    expect(signTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['max_batch_receivers', 49], ['supported_durations', ['2h']], ['energy_presets', [1]]
  ])('U1 rejects conflicting config aliases: %s', async (key, value) => {
    const { client } = harness({ config: { ...appFixture.config, [key]: value } });
    await expect(client.quote(quoteInput())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each([['total_sun', 1], ['payment_address', RECEIVER]])('U1 rejects conflicting quote aliases: %s', async (key, value) => {
    const { client } = harness({ quote: { ...appFixture.quote, [key]: value } });
    await expect(client.quote(quoteInput())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('U1 accepts equal legacy/current aliases', async () => {
    const { client } = harness({ config: { ...appFixture.config, max_batch_receivers: '50', supported_durations: ['1h'], energy_presets: [65000, 131000] }, quote: { ...appFixture.quote, total_sun: '2405000', payment_address: PAY_ADDRESS } });
    await expect(client.quote(quoteInput())).resolves.toMatchObject({ total_sun: 2405000 });
  });

  it.each([24999, 25000, 25001, 4999999, 5000000, 5000001])('U3 energy boundary %s', async energy => {
    const { client } = harness();
    const result = client.quote(quoteInput({ energyPerReceiver: energy }));
    if (energy < 25000 || energy > 5000000) await expect(result).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    else await expect(result).resolves.toHaveProperty('total_sun', 2405000);
  });
  it.each([0, 1, 2, 49, 50, 51])('U3 receiver count boundary %s', async count => {
    const { client } = harness();
    const result = client.quote(quoteInput({ receivers: Array(count).fill(RECEIVER) }));
    if (!count) await expect(result).rejects.toMatchObject({ code: 'EMPTY_RECEIVERS' });
    else if (count > 50) await expect(result).rejects.toMatchObject({ code: 'ADDR_OVERFLOW' });
    else await expect(result).resolves.toHaveProperty('total_sun');
  });
  it.each([0, 1, 2, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, '', ' ', true, [], {}, '1e3', 1.5])('U3 quoted SUN validation: %j', async amount => {
    const { client } = harness({ quote: { ...appFixture.quote, amount_sun: amount } });
    const result = client.quote(quoteInput());
    if (Number.isSafeInteger(amount) && amount > 0) await expect(result).resolves.toHaveProperty('total_sun', amount);
    else await expect(result).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each([undefined, '2h', '', ' '])('U3 rejects an unavailable duration: %j', async duration => {
    const { client, signTransaction } = harness();
    await expect(client.purchase(purchaseInput(signTransaction, { duration }))).rejects.toMatchObject({ code: 'INVALID_DURATION' });
    expect(signTransaction).not.toHaveBeenCalled();
  });
  it('U3 validates the quote payee and refreshes cached config before purchase', async () => {
    const { client, signTransaction } = harness({ quote: { ...appFixture.quote, pay_address: 'invalid' } });
    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(signTransaction).not.toHaveBeenCalled();
    const fresh = harness({ config: { ...appFixture.config, max_energy: 64000 } });
    await expect(fresh.client.purchase(purchaseInput(fresh.signTransaction, { config: appFixture.config })))
      .rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(fresh.signTransaction).not.toHaveBeenCalled();
  });

  it.each([1, 2, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, 'opaque-id'])('U4 accepts order id %s without token and never polls', async id => {
    const { client, fetch, signTransaction } = harness({ buy: { id, state: 'paid' } });
    const result = await client.purchase(purchaseInput(signTransaction));
    expect(result).toMatchObject({ orderId: String(id), state: 'paid', detail: null, reconciliationRequired: true });
    expect(fetch.mock.calls.some(([url]) => new URL(url).pathname.includes('/orders/'))).toBe(false);
    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({ code: 'PAYMENT_RISK_UNRESOLVED' });
    expect(signTransaction).toHaveBeenCalledTimes(1);
  });
  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, '', ' ', null, {}, []])('U4 malformed accepted id %j remains blocked across restart', async id => {
    const { client, signTransaction, storage } = harness({ buy: { id } });
    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const restarted = harness({}, storage);
    await expect(restarted.client.purchase(purchaseInput(restarted.signTransaction))).rejects.toMatchObject({ code: 'PAYMENT_RISK_UNRESOLVED' });
    expect(restarted.signTransaction).not.toHaveBeenCalled();
    await expect(restarted.client.clearPaymentRisk(PAYER)).rejects.toMatchObject({ code: 'MANUAL_RESOLUTION_REQUIRED' });
  });

  it.each([
    { id: 7, batch: { id: 8 } },
    { id: 7, access_token: 'one', batch: { id: '7', access_token: 'two' } },
    { id: 7, tx_id: TX_ID, payment: { tx_hash: 'ef'.repeat(32) } },
    { id: 7, state: { access_token: 'secret-in-state' } },
    null, false
  ])('U4/U8 rejects malformed/conflicting accepted identities without unlocking: %j', async order => {
    const { client, signTransaction } = harness({ buy: () => envelope(order) });
    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(JSON.stringify(client.getPaymentRisk(PAYER))).not.toContain('secret-in-state');
    await expect(client.clearPaymentRisk(PAYER)).rejects.toMatchObject({ code: 'MANUAL_RESOLUTION_REQUIRED' });
  });

  it('U5 exposes public history and preserves totals rather than synthesizing an empty result', async () => {
    const history = { rows: [{ order_id: 7, payment_tx_id: TX_ID, receiver: RECEIVER }], total: 21 };
    const { client, fetch } = harness({ history });
    expect(await client.getHistory(PAYER, { page: 2, size: 20 })).toEqual(history);
    const [url, opts] = fetch.mock.calls[0];
    expect(new URL(url).searchParams.get('address')).toBe(PAYER);
    expect(new URL(url).searchParams.get('page')).toBe('2');
    expect(new URL(url).searchParams.get('size')).toBe('20');
    expect(opts.method).toBe('GET');
    expect(opts.headers).not.toHaveProperty('X-Consumer-Order-Token');
  });
  it.each([0, 1, 2, 199, 200, 201])('U5 history size boundary %s', async size => {
    const { client } = harness();
    const result = client.getHistory(PAYER, { size });
    if (size < 1 || size > 200) await expect(result).rejects.toMatchObject({ code: 'INVALID_PAGINATION' });
    else await expect(result).resolves.toEqual({ rows: [], total: 0 });
  });
  it.each([0, 1, 2, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])('U5 history page boundary %s', async page => {
    const { client } = harness();
    const result = client.getHistory(PAYER, { page });
    if (!Number.isSafeInteger(page) || page < 1) await expect(result).rejects.toMatchObject({ code: 'INVALID_PAGINATION' });
    else await expect(result).resolves.toHaveProperty('total', 0);
  });
  it.each([{ rows: [] }, { rows: {}, total: 0 }, { rows: [null], total: 1 }, { rows: [], total: -1 }, { rows: [], total: '0' }])('U5 rejects malformed history: %j', async history => {
    const { client } = harness({ history });
    await expect(client.getHistory(PAYER)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  function storedRisk(storage, overrides = {}) {
    storage.setItem(`justlend_energy_purchase_risk:${encodeURIComponent(PAYER)}`, JSON.stringify([{
      payerAddress: PAYER, intentId: 'restart-intent', signedTxId: TX_ID, state: 'signed', createdAt: 1, expiresAt: 300001,
      paymentConfirmed: false, networkFingerprint: 'api=https://energy.example.com;provider=https://api.trongrid.io', ...overrides
    }]));
  }
  it('U6/U8 recovers via exact public history after restart without signing, replaying or storing credentials', async () => {
    const storage = memoryStorage(); storedRisk(storage);
    const { client, fetch, signTransaction } = harness({ history: { rows: [{ order_id: 7, payment_tx_id: TX_ID, payer_address: PAYER, state: 'delivered', access_token: 'must-not-persist' }], total: 1 } }, storage);
    const [risk] = await client.reconcilePaymentRisks(PAYER);
    expect(risk).toMatchObject({ paymentConfirmed: true, recoveredOrder: { id: '7', tx_id: TX_ID }, replayAvailable: false });
    // History is one row per receiver; one row's delivery is not the whole order.
    expect(risk.recoveredOrder).not.toHaveProperty('state');
    expect(JSON.stringify(risk)).not.toContain('must-not-persist');
    expect(storage.getItem(`justlend_energy_purchase_risk:${encodeURIComponent(PAYER)}`)).not.toContain('must-not-persist');
    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({ code: 'PAYMENT_RISK_UNRESOLVED' });
    expect(signTransaction).not.toHaveBeenCalled();
    expect(fetch.mock.calls.every(([, opts]) => opts.method === 'GET')).toBe(true);
    await client.clearPaymentRisk(PAYER, risk.intentId);
    expect(client.getPaymentRisk(PAYER)).toBeNull();
  });
  it.each(['empty', 'other tx', 'other payer', 'failed', 'page missing', 'other network', 'other api'])('U6 never unlocks for %s history', async kind => {
    const storage = memoryStorage();
    storedRisk(storage, kind === 'other network' ? { networkFingerprint: 'api=https://energy.example.com;provider=nile' } : kind === 'other api' ? { networkFingerprint: 'api=https://other.example.com;provider=https://api.trongrid.io' } : {});
    let history = { rows: [{ order_id: 7, payment_tx_id: TX_ID, payer_address: PAYER }], total: 1 };
    if (kind === 'other tx') history.rows[0].payment_tx_id = 'cd'.repeat(32);
    if (kind === 'other payer') history.rows[0].payer_address = RECEIVER;
    if (kind === 'empty' || kind === 'page missing') history = { rows: [], total: kind === 'page missing' ? 100 : 0 };
    if (kind === 'failed') history = () => { throw new Error('offline'); };
    const { client, fetch, signTransaction } = harness({ history }, storage);
    const [risk] = await client.reconcilePaymentRisks(PAYER);
    expect(risk.paymentConfirmed).toBe(false);
    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({ code: 'PAYMENT_RISK_UNRESOLVED' });
    expect(signTransaction).not.toHaveBeenCalled();
    if (kind.startsWith('other ') && ['other api', 'other network'].includes(kind)) expect(fetch).not.toHaveBeenCalled();
  });
  it('U6 can explicitly inspect a later history page without treating earlier absence as final', async () => {
    const storage = memoryStorage(); storedRisk(storage);
    const { client } = harness({ history: url => envelope(new URL(url).searchParams.get('page') === '2'
      ? { rows: [{ order_id: 7, payment_tx_id: TX_ID }], total: 21 } : { rows: [], total: 21 }) }, storage);
    expect((await client.reconcilePaymentRisks(PAYER))[0].paymentConfirmed).toBe(false);
    expect((await client.reconcilePaymentRisks(PAYER, { history: { page: 2, size: 20 } }))[0].paymentConfirmed).toBe(true);
  });
  it('U7 a deterministic rejection after an uncertain attempt cannot erase the earlier payment risk', async () => {
    let attempt = 0;
    const { client, signTransaction } = harness({ buy: () => {
      if (++attempt === 1) throw new Error('timeout after acceptance');
      return response({ code: 'TX_EXPIRED', msg: 'later attempt expired' }, 400);
    } });
    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({ code: 'TX_EXPIRED' });
    expect(client.getPaymentRisk(PAYER)).not.toBeNull();
    await expect(client.reconcilePaymentRisks(PAYER, { confirmReplay: true })).resolves.toHaveLength(1);
    await expect(client.purchase(purchaseInput(signTransaction))).rejects.toMatchObject({ code: 'PAYMENT_RISK_UNRESOLVED' });
    expect(signTransaction).toHaveBeenCalledTimes(1);
  });
  it.each(['failed', 'expired', 'callback'])('U7 top-level accepted %s failure retains risk', async kind => {
    const { client, signTransaction, storage } = harness({ detail: { state: kind === 'callback' ? 'delivered' : kind } });
    await expect(client.purchase(purchaseInput(signTransaction, { onOrderAccepted: () => { if (kind === 'callback') throw new Error('callback failed'); } }))).rejects.toThrow();
    const restarted = harness({}, storage);
    expect(restarted.client.getPaymentRisk(PAYER)).toMatchObject({ paymentConfirmed: true });
    await expect(restarted.client.purchase(purchaseInput(restarted.signTransaction))).rejects.toMatchObject({ code: 'PAYMENT_RISK_UNRESOLVED' });
    expect(restarted.signTransaction).not.toHaveBeenCalled();
  });

  it('U5 rejects an invalid history address before making a request', async () => {
    const { client, fetch } = harness();
    await expect(client.getHistory('bad-address')).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
