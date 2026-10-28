import { assertTronAddress, getNetworkType, view } from './blockchain';
import { getContractsAddress } from './systemV2';

const ZERO_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

/**
 * Read independent permission flags reported in issue #3. These selectors may
 * be absent in another deployment. Never infer a deployed gate's boolean logic,
 * borrower health, a successful quote, or permission to send from these flags.
 */
export async function getLiquidationPermissionDiagnostics(input = {}) {
  const { marketId, borrower, caller } = input;
  if (typeof marketId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(marketId)) {
    throw new Error('marketId must be a 0x-prefixed bytes32 value.');
  }
  assertTronAddress(borrower, 'borrower address');
  assertTronAddress(caller, 'caller address');
  const network = getNetworkType();
  const moolahProxy = input.moolahProxy ?? getContractsAddress('MoolahProxy');
  const publicLiquidatorProxy = input.publicLiquidatorProxy ?? getContractsAddress('PublicLiquidatorProxy');
  assertTronAddress(moolahProxy, 'moolah proxy address');
  assertTronAddress(publicLiquidatorProxy, 'public liquidator proxy address');
  const id = { type: 'bytes32', value: marketId };
  const account = value => ({ type: 'address', value });
  const requests = [
    ['coreCaller', moolahProxy, 'isLiquidationWhitelist(bytes32,address)', [id, account(caller)]],
    ['corePublicLiquidator', moolahProxy, 'isLiquidationWhitelist(bytes32,address)', [id, account(publicLiquidatorProxy)]],
    ['coreOpen', moolahProxy, 'isLiquidationWhitelist(bytes32,address)', [id, account(ZERO_ADDRESS)]],
    ['market', publicLiquidatorProxy, 'marketWhitelist(bytes32)', [id]],
    ['borrower', publicLiquidatorProxy, 'marketUserWhitelist(bytes32,address)', [id, account(borrower)]]
  ];
  const checks = {};
  for (const [key, contract, selector, parameters] of requests) {
    checks[key] = null;
    if (getNetworkType() !== network) throw new Error('Network changed during liquidation diagnostics. Retry the read.');
    try {
      const result = await view(contract, selector, parameters);
      if (Array.isArray(result) && result.length === 1 && typeof result[0] === 'string' && /^0{63}[01]$/.test(result[0])) {
        checks[key] = result[0].endsWith('1');
      }
    } catch {
      // Unknown must remain distinct from a verified false flag.
    }
  }
  if (getNetworkType() !== network) throw new Error('Network changed during liquidation diagnostics. Retry the read.');
  return {
    network, marketId, borrower, caller, contracts: { moolahProxy, publicLiquidatorProxy }, checks,
    unavailable: Object.keys(checks).filter(key => checks[key] === null),
    permission: 'not_evaluated', health: 'not_checked', quote: 'not_requested', canLiquidate: null,
    note: 'Diagnostic flags only. Verify the deployed permission logic, current health and quote before separately confirming any liquidation. Never widen a whitelist automatically.'
  };
}
