import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as blockchain from '../utils/blockchain';
import { getLiquidationPermissionDiagnostics } from '../utils/liquidationDiagnostics';
const address = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const input = { marketId: '0x' + 'a'.repeat(64), borrower: address, caller: address };
let read, previousNetwork;
beforeEach(() => {
  previousNetwork = blockchain.tronObj.network;
  blockchain.tronObj.network = 'main';
  read = vi.spyOn(blockchain, 'view').mockResolvedValue(['0'.repeat(63) + '1']);
});
afterEach(() => { blockchain.tronObj.network = previousNetwork; vi.restoreAllMocks(); });
it.each([63, 64, 65])('validates a market ID at %s hex digits before reads', async length => {
  const promise = getLiquidationPermissionDiagnostics({ ...input, marketId: '0x' + 'a'.repeat(length) });
  if (length === 64) { await promise; expect(read).toHaveBeenCalledTimes(5); }
  else { await expect(promise).rejects.toThrow(/marketId/); expect(read).not.toHaveBeenCalled(); }
});
it.each(['borrower', 'caller', 'moolahProxy', 'publicLiquidatorProxy'])('rejects an invalid %s before reads', async key => {
  await expect(getLiquidationPermissionDiagnostics({ ...input, [key]: 'invalid' })).rejects.toThrow(/address/);
  expect(read).not.toHaveBeenCalled();
});
it('separates EOA/core-route/open/market/borrower observations and never claims liquidation eligibility', async () => {
  read.mockResolvedValueOnce(['0'.repeat(64)]);
  const result = await getLiquidationPermissionDiagnostics(input);
  expect(result.checks).toEqual({ coreCaller: false, corePublicLiquidator: true, coreOpen: true, market: true, borrower: true });
  expect(result.canLiquidate).toBeNull();
  expect(result.health).toBe('not_checked');
  expect(result.permission).toBe('not_evaluated');
  expect(read.mock.calls.map(([, selector]) => selector)).toEqual([
    'isLiquidationWhitelist(bytes32,address)', 'isLiquidationWhitelist(bytes32,address)',
    'isLiquidationWhitelist(bytes32,address)', 'marketWhitelist(bytes32)', 'marketUserWhitelist(bytes32,address)'
  ]);
  expect(read.mock.calls[1][2][1].value).toBe(result.contracts.publicLiquidatorProxy);
});
it.each([[], [null], ['1'], ['0'.repeat(63) + '2'], [true]])('malformed bool %j remains unknown without losing sibling observations', async value => {
  read.mockResolvedValueOnce(value);
  const result = await getLiquidationPermissionDiagnostics(input);
  expect(result.checks.coreCaller).toBeNull();
  expect(result.checks.market).toBe(true);
  expect(result.unavailable).toEqual(['coreCaller']);
  expect(result.canLiquidate).toBeNull();
});
it('RPC failure is unknown, not permission denied or allowed', async () => {
  read.mockRejectedValue(new Error('RPC unavailable'));
  const result = await getLiquidationPermissionDiagnostics(input);
  expect(Object.values(result.checks)).toEqual([null, null, null, null, null]);
  expect(result.canLiquidate).toBeNull();
});
it.each([1, 5])('rejects a network switch during read %s rather than combining deployments', async changeAt => {
  let calls = 0;
  read.mockImplementation(async () => {
    if (++calls === changeAt) blockchain.tronObj.network = 'nile';
    return ['0'.repeat(63) + '1'];
  });
  await expect(getLiquidationPermissionDiagnostics(input)).rejects.toThrow(/Network changed/);
  expect(read).toHaveBeenCalledTimes(changeAt);
});
