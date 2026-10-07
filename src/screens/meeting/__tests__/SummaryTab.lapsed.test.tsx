import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import SummaryTab from '../SummaryTab';

/**
 * F18 (D03): the whole chain, with the REAL subscription.ts and a native licence stand-in that
 * behaves like Licence.kt — `store('', null)` leaves state NONE. Before this, the H1 fix dropped
 * the token and the Summary then showed the Free upsell, so the lapsed card (Check again /
 * Manage in Google Play) could never be reached by a person whose Pro the server had just ended.
 */
const mockLic: { state: 'none' | 'active' | 'expired'; key: string | null; expiresAt: number } = {
  state: 'expired',
  key: 'refresh-1',
  expiresAt: 1,
};
const mockSettings = new Map<string, string>();

jest.mock('../../../native/NativeLicence', () => ({
  __esModule: true,
  default: {
    status: jest.fn(async () => ({
      plan: mockLic.state === 'none' ? 'free' : 'pro',
      state: mockLic.state,
      paid: mockLic.state === 'active',
      expiresAt: mockLic.expiresAt,
      account: null,
      lapsedCopy: 'Pro is off on this phone.',
    })),
    store: jest.fn(async (token: string, key: string | null) => {
      mockLic.state = token ? 'active' : 'none';
      mockLic.expiresAt = token ? 4_000_000_000 : 0;
      if (key !== null) mockLic.key = key;
      return true;
    }),
    refreshKey: jest.fn(async () => mockLic.key),
    baseUrl: jest.fn(async () => 'https://verbale.example.com'),
    deviceId: jest.fn(async () => 'device-1'),
    clear: jest.fn(async () => {
      mockLic.state = 'none';
      mockLic.key = null;
    }),
  },
}));
jest.mock('../../../native/NativeBilling', () => ({
  __esModule: true,
  default: {
    available: jest.fn(async () => false),
    plans: jest.fn(async () => []),
    restore: jest.fn(async () => null),
  },
}));
jest.mock('../../../native/NativeLlm', () => ({
  __esModule: true,
  default: { available: jest.fn(async () => true), capable: jest.fn(async () => true) },
}));
jest.mock('../../../privacy/ledger', () => ({
  hostOf: () => 'verbale.example.com',
  record: jest.fn(async () => {}),
}));
jest.mock('../../../db/queries', () => ({
  db: {
    getSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
    setSetting: jest.fn(async (k: string, v: string) => {
      mockSettings.set(k, v);
    }),
  },
}));

import { refreshIfNeeded } from '../../../billing/subscription';

const NOW = 1_800_000_000;
const reply = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) } as Response);

const baseProps = {
  items: [] as any[],
  minutes: [] as any[],
  speakers: [] as any[],
  speechMs: 60_000,
  highlights: [] as any[],
  onOpenProvenance: jest.fn(),
  canPlay: false,
  onRemoveMark: jest.fn(),
  onWrite: jest.fn(),
  onOpenTab: jest.fn(),
  writing: false,
  template: 'standup' as string | null,
  onChangeTemplate: jest.fn(),
  threads: [] as { tag: string; open: number; decisions: number }[],
  onOpenThread: jest.fn(),
  voiceSuggestions: [] as string[],
  onConfirmVoices: jest.fn(),
  transcriptChars: undefined as number | undefined,
  onUpgrade: jest.fn(),
  onEdit: jest.fn(),
  onCopy: jest.fn(),
};

async function renderTab() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<SummaryTab {...baseProps} />);
  });
  return tree;
}
const has = (tree: renderer.ReactTestRenderer, label: string) =>
  tree.root.findAllByProps({ label }, { deep: false }).length > 0;

beforeEach(() => {
  mockSettings.clear();
  mockLic.state = 'active';
  mockLic.key = 'refresh-1';
  mockLic.expiresAt = NOW + 2 * 24 * 60 * 60; // inside the renew window
  global.fetch = jest.fn();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

describe('the server says no to a person who had Pro', () => {
  test('the Summary shows Check again and Manage, not the Free upsell', async () => {
    (global.fetch as jest.Mock).mockReturnValue(reply({ token: null, plan: 'free', expiresAt: 0 }));
    await refreshIfNeeded(NOW);
    expect(mockLic.state).toBe('none'); // the native side really does report NONE now
    const tree = await renderTab();
    expect(has(tree, 'Check again')).toBe(true);
    expect(has(tree, 'Manage in Google Play')).toBe(true);
  });

  test('a Check again that finds Pro again clears the lapsed card', async () => {
    (global.fetch as jest.Mock).mockReturnValueOnce(reply({ token: null, plan: 'free', expiresAt: 0 }));
    await refreshIfNeeded(NOW);
    const tree = await renderTab();
    expect(has(tree, 'Check again')).toBe(true);

    (global.fetch as jest.Mock).mockReturnValue(
      reply({ token: 'licence-new', plan: 'pro', expiresAt: 4_000_000_000 }),
    );
    await act(async () => {
      tree.root.findByProps({ label: 'Check again' }).props.onPress();
    });
    expect(mockLic.state).toBe('active');
    expect(mockSettings.get('pro_lapsed_at')).toBe('');
    expect(has(tree, 'Check again')).toBe(false);
  });

  test('a Check again that the server still refuses keeps the lapsed card', async () => {
    (global.fetch as jest.Mock).mockReturnValue(reply({ token: null, plan: 'free', expiresAt: 0 }));
    await refreshIfNeeded(NOW);
    const tree = await renderTab();
    await act(async () => {
      tree.root.findByProps({ label: 'Check again' }).props.onPress();
    });
    expect(has(tree, 'Check again')).toBe(true);
  });
});

describe('a person who never had Pro', () => {
  test('a signed-in Free account told "no" never sees the lapsed card', async () => {
    mockLic.state = 'none';
    mockLic.expiresAt = 0;
    (global.fetch as jest.Mock).mockReturnValue(reply({ token: null, plan: 'free', expiresAt: 0 }));
    await refreshIfNeeded(NOW);
    expect(global.fetch).toHaveBeenCalled(); // it WAS asked, and told no
    const tree = await renderTab();
    expect(has(tree, 'Check again')).toBe(false);
    expect(has(tree, 'Manage in Google Play')).toBe(false);
  });
});

describe('a refresh that gets no answer', () => {
  test('keeps the token and sets no lapsed flag', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError('Network request failed'));
    await refreshIfNeeded(NOW);
    expect(mockLic.state).toBe('active');
    expect(mockSettings.has('pro_lapsed_at')).toBe(false);
  });
});
