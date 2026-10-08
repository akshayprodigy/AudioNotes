import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AllowanceExhausted, AllowanceLine, isExhausted } from '../AllowanceNote';
import { exhaustedCopy, remainingCopy } from '../../billing/allowanceCopy';
import type { AllowanceStatus } from '../../native/NativeLicence';

const free = (over: Partial<AllowanceStatus> = {}): AllowanceStatus => ({
  limit: 5, used: 2, remaining: 3, period: '2026-10', resetsOn: '2026-11-01', paid: false, ...over,
});

const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);

const render = async (el: React.ReactElement) => {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(el);
  });
  return tree;
};

describe('isExhausted', () => {
  it('is true for a Free phone with none left', () => {
    expect(isExhausted(free({ used: 5, remaining: 0 }))).toBe(true);
  });
  it('is false while a meeting is left, for Pro, and until native has answered', () => {
    expect(isExhausted(free())).toBe(false);
    expect(isExhausted(free({ used: 5, remaining: 0, paid: true }))).toBe(false);
    expect(isExhausted(null)).toBe(false);
  });
});

describe('AllowanceLine', () => {
  it('says what is left and when it resets', async () => {
    const tree = await render(<AllowanceLine status={free()} />);
    expect(texts(tree)).toContain(remainingCopy(3, 5, '2026-11-01'));
  });

  it('renders nothing for Pro, and nothing before native has answered', async () => {
    expect((await render(<AllowanceLine status={free({ paid: true })} />)).toJSON()).toBeNull();
    expect((await render(<AllowanceLine status={null} />)).toJSON()).toBeNull();
  });
});

describe('AllowanceExhausted', () => {
  it('shows the exhausted copy and an upgrade button that opens the paywall', async () => {
    const onUpgrade = jest.fn();
    const tree = await render(<AllowanceExhausted resetsOn="2026-11-01" onUpgrade={onUpgrade} />);
    expect(texts(tree)).toContain(exhaustedCopy('2026-11-01'));
    expect(texts(tree)).toContain('Get Pro');
    // Raised puts the press on the Pressable it draws; the first node carrying one is the button.
    const press = tree.root.find(n => typeof n.props.onPress === 'function');
    act(() => press.props.onPress());
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });
});

describe('AllowanceExhausted: the upgrade button', () => {
  // Nothing A069: the button read "Get Pro" beside a tick, which says "done", not "upgrade".
  it('carries the Pro mark, not a tick', async () => {
    const tree = await render(<AllowanceExhausted resetsOn="2026-11-01" onUpgrade={() => {}} />);
    const button = tree.root.findAll(n => n.props.label === 'Get Pro' && n.props.icon !== undefined)[0];
    expect(button.props.icon).toBe('ai');
  });
});
