import React from 'react';
import { Text } from 'react-native';
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
const press = (tree: renderer.ReactTestRenderer, label: string) => {
  const hit = tree.root.find(n => typeof n.props.onPress === 'function' && n.findAll(c => c.props.children === label).length > 0);
  act(() => hit.props.onPress());
};
const pressable = (tree: renderer.ReactTestRenderer, label: string) =>
  tree.root.findAll(n => typeof n.props.onPress === 'function' && n.findAll(c => c.props.children === label).length > 0);

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

test('Pro: Manage in Google Play is pressed and calls onManage once', () => {
  const { tree, props } = mount({ lic: PRO });
  press(tree, 'Manage in Google Play');
  expect(props.onManage).toHaveBeenCalledTimes(1);
  expect(props.onSignOut).not.toHaveBeenCalled();
});

test('Pro signed in: Sign out is pressed and calls onSignOut once', () => {
  const { tree, props } = mount({ lic: PRO, signedInAs: 'a@b.c' });
  press(tree, 'Sign out');
  expect(props.onSignOut).toHaveBeenCalledTimes(1);
});

test('Pro not signed in has no Sign out', () => {
  const { tree } = mount({ lic: PRO });
  expect(texts(tree)).not.toContain('Sign out');
});

test('Free: Restore a purchase is pressed and calls onRestorePurchase once', () => {
  const { tree, props } = mount();
  press(tree, 'Restore a purchase');
  expect(props.onRestorePurchase).toHaveBeenCalledTimes(1);
});

test('Free while Play is busy: Restore a purchase has no press handler', () => {
  const { tree, props } = mount({ playBusy: true });
  expect(texts(tree)).toContain('Restore a purchase');
  expect(pressable(tree, 'Restore a purchase')).toHaveLength(0);
  expect(props.onRestorePurchase).not.toHaveBeenCalled();
});

test('Free without Play, signed in: Sign out is shown and pressed', () => {
  const { tree, props } = mount({ playCan: false, signedInAs: 'a@b.c', emailSignIn: <Text>FORM-MARKER</Text> });
  expect(texts(tree)).not.toContain('FORM-MARKER');
  expect(texts(tree)).not.toContain('See Pro plans');
  press(tree, 'Sign out');
  expect(props.onSignOut).toHaveBeenCalledTimes(1);
});

test('Free without Play, not signed in: the sign-in form is in the card', () => {
  const { tree } = mount({ playCan: false, emailSignIn: <Text>FORM-MARKER</Text> });
  expect(texts(tree)).toContain('FORM-MARKER');
  expect(texts(tree)).not.toContain('Sign out');
  expect(texts(tree)).not.toContain('Restore a purchase');
});
