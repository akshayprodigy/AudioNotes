import fs from 'fs';
import path from 'path';
import React from 'react';
import { Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import SharePreviewScreen from '../SharePreviewScreen';
import FileExport from '../../native/NativeFileExport';
import Licence from '../../native/NativeLicence';
import { useAllowanceStore, isExhausted } from '../../billing/allowance';
import { db } from '../../db/queries';

/**
 * Sharing is free, for everyone, always: when the monthly Free allowance is spent and when Pro has
 * lapsed. Nothing on this path asks a licence or an allowance anything.
 */
jest.mock('../../db/queries');
jest.mock('../../native/NativeFileExport', () => ({
  __esModule: true,
  default: { preview: jest.fn(async () => '# Notes\n'), shareWith: jest.fn(async () => {}) },
}));
jest.mock('../../native/NativeLicence', () => ({
  __esModule: true,
  default: {
    allowance: jest.fn(async () => ({
      limit: 5, used: 5, remaining: 0, period: '2026-10', resetsOn: '2026-11-01', paid: false,
    })),
    status: jest.fn(async () => ({ state: 'expired', paid: false })),
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const flat = (c: any): string =>
  Array.isArray(c) ? c.map(flat).join('') : typeof c === 'string' ? c : c?.props ? flat(c.props.children) : '';

describe('sharing with the allowance spent and Pro lapsed', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  afterEach(() => {
    if (tree) act(() => tree!.unmount());
    tree = undefined;
  });

  it('keeps the Share button enabled, builds the document, and shares it', async () => {
    (db.getSetting as jest.Mock).mockResolvedValue(null);
    useAllowanceStore.setState({
      status: { limit: 5, used: 5, remaining: 0, period: '2026-10', resetsOn: '2026-11-01', paid: false } as any,
    });
    expect(isExhausted(useAllowanceStore.getState().status)).toBe(true);

    await act(async () => {
      tree = renderer.create(
        <SharePreviewScreen
          navigation={{ goBack: jest.fn(), navigate: jest.fn() } as any}
          route={{ key: 'k', name: 'Share', params: { meetingId: 'm1' } } as any}
        />,
      );
    });
    expect(FileExport.preview).toHaveBeenCalledWith('m1', 'pdf', false);

    const share = tree!.root
      .findAllByType(Text)
      .filter(n => flat(n.props.children) === 'Share')
      .map(t => {
        // The Pressable inside Raised: `disabled` is a boolean on it and on nothing nearer the text.
        let p: any = t.parent;
        while (p && typeof p.props.disabled !== 'boolean') p = p.parent;
        return p;
      })
      .filter(Boolean)[0]; // the header says "Share" too, but nothing presses it
    expect(share.props.disabled).toBe(false);
    expect(typeof share.props.onPress).toBe('function');
    await act(async () => {
      share.props.onPress();
    });
    expect(FileExport.shareWith).toHaveBeenCalledWith('m1', 'pdf', false);

    // Nothing asked who is allowed: native licence and allowance were never consulted.
    expect(Licence.allowance).not.toHaveBeenCalled();
    expect(Licence.status).not.toHaveBeenCalled();
  });

  it('has no import from billing, licence or allowance anywhere under src/share', () => {
    const dir = path.resolve(__dirname, '..');
    const files = fs.readdirSync(dir).filter(f => /\.(ts|tsx)$/.test(f));
    expect(files).toEqual(expect.arrayContaining(['SharePreviewScreen.tsx', 'markers.ts']));
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const imports = src.split('\n').filter(l => /^\s*import\b|require\(/.test(l)).join('\n');
      expect(imports).not.toMatch(/billing|NativeLicence|allowance|subscription|licence/i);
    }
  });

  it('and the native builder takes no licence or allowance either', () => {
    const kt = fs.readFileSync(
      path.resolve(__dirname, '../../../android/app/src/main/java/com/innocorelabs/verbale/pipeline/ShareDocument.kt'),
      'utf8',
    );
    expect(kt).not.toMatch(/Licence|Allowance|entitled|Subscription/);
  });
});
