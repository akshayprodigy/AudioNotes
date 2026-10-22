import React from 'react';
import renderer, { act } from 'react-test-renderer';
import PlanSection from '../PlanSection';
import type { LicenceStatus, AllowanceStatus } from '../../../native/NativeLicence';

const ALLOWANCE: AllowanceStatus = {
  limit: 5, used: 2, remaining: 3, period: '2026-10', resetsOn: '2026-11-01', paid: false,
};
const PRO: LicenceStatus = {
  plan: 'pro', state: 'active', paid: true,
  expiresAt: Math.floor(new Date(2026, 9, 29, 12).getTime() / 1000), account: null, lapsedCopy: '',
};
const FREE: LicenceStatus = { plan: 'free', state: 'none', paid: false, expiresAt: 0, account: null, lapsedCopy: '' };

function mount(over: Record<string, unknown> = {}) {
  const props = {
    lic: FREE, allowance: ALLOWANCE as AllowanceStatus | null, hasServer: true, playCan: true,
    playBusy: false, signedInAs: null as string | null,
    onManage: jest.fn(), onRestorePurchase: jest.fn(), onSignOut: jest.fn(), onSeePlans: jest.fn(),
    emailSignIn: null as React.ReactNode, ...over,
  };
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(<PlanSection {...(props as any)} />); });
  return { tree, props };
}
const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);

test('Pro shows plan, end date and Manage, and nothing that sells Pro', () => {
  const { tree } = mount({ lic: PRO, allowance: { ...ALLOWANCE, paid: true } });
  const t = texts(tree);
  expect(t).toContain('CURRENT PLAN');
  expect(t).toContain('Pro');
  expect(t).toContain('Active through 29 October');
  expect(t).toContain('Renews in Google Play unless you cancel.');
  expect(t).toContain('Manage in Google Play');
  for (const gone of ['See Pro plans', 'Restore a purchase', 'I already have an account', 'Free allowance', 'Unlimited with Pro']) {
    expect(t).not.toContain(gone);
  }
  expect(t.some(x => /\bleft\b/.test(x))).toBe(false);
});

test('Pro with no expiry says everything is on, with no date line', () => {
  const { tree } = mount({ lic: { ...PRO, expiresAt: 0 } });
  const t = texts(tree);
  expect(t).toContain('Everything in Pro is on.');
  expect(t.some(x => /Active through/.test(x))).toBe(false);
});

test('Pro signed in offers Sign out', () => {
  const { tree, props } = mount({ lic: PRO, signedInAs: 'a@b.c' });
  const link = tree.root.findAll(n => n.props.accessibilityLabel === 'Sign out' || n.props.children === 'Sign out');
  expect(link.length).toBeGreaterThan(0);
  expect(props.onSignOut).not.toHaveBeenCalled();
});

test('Free shows allowance, See Pro plans (pressable), restore and account links, no Manage', () => {
  const { tree, props } = mount();
  const t = texts(tree);
  expect(t).toContain('CURRENT PLAN');
  expect(t).toContain('Free');
  expect(t).toContain('3 of 5 left · resets 1 November');
  expect(t).toContain('Restore a purchase');
  expect(t).toContain('I already have an account');
  expect(t).not.toContain('Manage in Google Play');
  expect(t).not.toContain('Free allowance');
  const btn = tree.root.findAll(n => typeof n.props.onPress === 'function' && n.findAll(c => c.props.children === 'See Pro plans').length > 0);
  act(() => btn[btn.length - 1].props.onPress());
  expect(props.onSeePlans).toHaveBeenCalled();
});

test('restore is disabled while Play is busy', () => {
  const { tree, props } = mount({ playBusy: true });
  const link = tree.root.findAll(n => n.props.accessibilityRole === 'button' && n.findAll(c => c.props.children === 'Restore a purchase').length > 0);
  expect(link.length).toBeGreaterThan(0);
  act(() => link[0].props.onPress?.());
  expect(props.onRestorePurchase).not.toHaveBeenCalled();
});

test('I already have an account expands the form with its explanation', () => {
  const { tree } = mount({ emailSignIn: <>{'FORM-HERE'}</> });
  const link = tree.root.findAll(n => n.props.accessibilityRole === 'button' && n.findAll(c => c.props.children === 'I already have an account').length > 0);
  act(() => link[0].props.onPress());
  const t = texts(tree);
  expect(t).toContain('For an account that already has a subscription.');
});

test('expired with lapsed copy shows the line', () => {
  const { tree } = mount({ lic: { ...FREE, state: 'expired', lapsedCopy: 'Your Pro ended on 1 October.' } });
  expect(texts(tree)).toContain('Your Pro ended on 1 October.');
});

test('no server: one muted line and nothing interactive', () => {
  const { tree } = mount({ hasServer: false });
  const t = texts(tree);
  expect(t).toContain('This build has no licence server configured.');
  expect(t).not.toContain('See Pro plans');
  expect(t).not.toContain('Restore a purchase');
});

test('until the licence is read nothing but the overline renders', () => {
  const { tree } = mount({ lic: null, hasServer: false });
  const t = Array.from(new Set(texts(tree)));
  expect(t).toEqual(['CURRENT PLAN']);
});
