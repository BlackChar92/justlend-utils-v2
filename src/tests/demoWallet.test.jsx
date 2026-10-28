// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const { provider } = vi.hoisted(() => ({ provider: vi.fn() }));

vi.mock('@tronweb3/tronwallet-adapter-react-hooks', () => ({
  WalletProvider: (props) => {
    provider(props);
    return props.children;
  },
}));

vi.mock('../Example.jsx', () => ({
  default: () => React.createElement('span', null, 'SDK example'),
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = '';
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

it('keeps the demo on one real TronLink adapter with automatic connection enabled', async () => {
  vi.useFakeTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';

  // Exercise the actual browser entry without connecting a wallet or invoking SDK calls.
  await act(async () => {
    await import('../index.jsx');
  });

  expect(provider).toHaveBeenCalled();
  const { adapters, autoConnect } = provider.mock.calls.at(-1)[0];
  expect(adapters).toHaveLength(1);
  expect(adapters[0].name).toBe('TronLink');
  expect(typeof adapters[0].connect).toBe('function');
  expect(typeof adapters[0].signTransaction).toBe('function');
  expect(adapters[0].connected).toBe(false);
  expect(autoConnect).toBe(true);
  expect(document.querySelector('#root').textContent).toBe('SDK example');
});
