import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve through the actual adapter graph, including pnpm's isolated installs.
const require = createRequire(import.meta.url);
const { devDependencies } = require('../../package.json');
const walletAdapters = '@tronweb3/tronwallet-adapters';
const hasWalletConnect = Object.hasOwn(devDependencies, walletAdapters);

function walletConnectRequire() {
  const adapters = createRequire(require.resolve(walletAdapters));
  const adapter = createRequire(adapters.resolve('@tronweb3/tronwallet-adapter-walletconnect'));
  return createRequire(adapter.resolve('@tronweb3/walletconnect-tron'));
}

describe('TronLink dependency compatibility', () => {
  it('loads the direct TronLink adapter used by the demo', async () => {
    const { TronLinkAdapter } = await import('@tronweb3/tronwallet-adapter-tronlink');
    expect(TronLinkAdapter).toBeTypeOf('function');
  });
});

// The TronLink-only demo does not install the WalletConnect dependency graph.
describe.skipIf(!hasWalletConnect)('WalletConnect dependency compatibility', () => {
  it('decodes query parameters with the patched ESM decoder', async () => {
    const utils = createRequire(walletConnectRequire().resolve('@walletconnect/utils'));
    const { default: queryString } = await import(pathToFileURL(utils.resolve('query-string')).href);
    expect(queryString.parse('message=hello%20world').message).toBe('hello world');
    expect(queryString.parse('bad=%E0%A4%A').bad).toBe('%E0%A4%A');
    expect(queryString.stringify({ message: 'hello world' })).toBe('message=hello%20world');
  });

  it('validates Reown wallet events with the patched Zod version', async () => {
    const appkit = createRequire(walletConnectRequire().resolve('@reown/appkit'));
    const { W3mFrameSchema, W3mFrameConstants } = await import(pathToFileURL(appkit.resolve('@reown/appkit-wallet')).href);
    const event = {
      type: W3mFrameConstants.APP_SYNC_THEME,
      payload: { themeVariables: { color: 'red', size: 12 } },
    };
    expect(W3mFrameSchema.appEvent.parse(event)).toEqual(event);
    expect(W3mFrameSchema.appEvent.safeParse({
      type: W3mFrameConstants.APP_CONNECT_EMAIL,
      payload: { email: 'not-an-email' },
    }).success).toBe(false);
  });
});
