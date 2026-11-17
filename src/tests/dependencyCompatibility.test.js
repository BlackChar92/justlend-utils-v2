import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve through the actual adapter graph, including pnpm's isolated installs.
const require = createRequire(import.meta.url);
const adapters = createRequire(require.resolve('@tronweb3/tronwallet-adapters'));
const adapter = createRequire(adapters.resolve('@tronweb3/tronwallet-adapter-walletconnect'));
const tron = createRequire(adapter.resolve('@tronweb3/walletconnect-tron'));
const utils = createRequire(tron.resolve('@walletconnect/utils'));
const appkit = createRequire(tron.resolve('@reown/appkit'));

describe('wallet dependency compatibility', () => {
  it('decodes query parameters with the patched ESM decoder', async () => {
    const { default: queryString } = await import(pathToFileURL(utils.resolve('query-string')).href);
    expect(queryString.parse('message=hello%20world').message).toBe('hello world');
    expect(queryString.parse('bad=%E0%A4%A').bad).toBe('%E0%A4%A');
    expect(queryString.stringify({ message: 'hello world' })).toBe('message=hello%20world');
  });

  it('validates Reown wallet events with the patched Zod version', async () => {
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
