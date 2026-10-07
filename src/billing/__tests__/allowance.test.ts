import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState } from 'react-native';
import Licence from '../../native/NativeLicence';
import { useRecordingStore } from '../../state/recordingStore';
import {
  fetchAllowance,
  refreshAllowance,
  useAllowance,
  useAllowanceStore,
  type AllowanceStatus,
} from '../allowance';

/** react-test-renderer has no renderHook: a probe component that reports what the hook returned. */
const mounted: renderer.ReactTestRenderer[] = [];
afterEach(() => {
  while (mounted.length) act(() => mounted.pop()!.unmount());
});

function renderHook() {
  const result: { current: AllowanceStatus | null } = { current: null };
  function Probe() {
    result.current = useAllowance();
    return null;
  }
  act(() => {
    mounted.push(renderer.create(React.createElement(Probe)));
  });
  return { result };
}

const mockAllowance = jest.fn();
(Licence as unknown as { allowance: jest.Mock }).allowance = mockAllowance;

const FREE = { limit: 5, used: 2, remaining: 3, period: '2026-10', resetsOn: '2026-11-01', paid: false };
const PRO = { ...FREE, used: 0, remaining: 5, paid: true };

beforeEach(() => {
  // The preset's AppState mock hands back nothing to remove; a real one hands back a subscription.
  jest.spyOn(AppState, 'addEventListener').mockImplementation((() => ({ remove: jest.fn() })) as never);
  mockAllowance.mockReset();
  useAllowanceStore.setState({ status: null });
  useRecordingStore.setState({ isRecording: false });
});

describe('fetchAllowance', () => {
  it('returns what native says, untouched', async () => {
    mockAllowance.mockResolvedValue(FREE);
    expect(await fetchAllowance()).toEqual(FREE);
  });

  it('says paid for a Pro phone', async () => {
    mockAllowance.mockResolvedValue(PRO);
    expect((await fetchAllowance())?.paid).toBe(true);
  });

  it('is null when native cannot say, so a screen shows nothing rather than a guess', async () => {
    mockAllowance.mockRejectedValue(new Error('db locked'));
    expect(await fetchAllowance()).toBeNull();
  });

  it('is null for a malformed answer', async () => {
    mockAllowance.mockResolvedValue({ limit: 5 });
    expect(await fetchAllowance()).toBeNull();
  });
});

describe('refreshAllowance', () => {
  it('puts the answer in the store', async () => {
    mockAllowance.mockResolvedValue(FREE);
    await refreshAllowance();
    expect(useAllowanceStore.getState().status).toEqual(FREE);
  });

  it('keeps the last good answer when a later read fails', async () => {
    mockAllowance.mockResolvedValue(FREE);
    await refreshAllowance();
    mockAllowance.mockRejectedValue(new Error('boom'));
    await refreshAllowance();
    expect(useAllowanceStore.getState().status).toEqual(FREE);
  });
});

describe('useAllowance', () => {
  it('reads on mount', async () => {
    mockAllowance.mockResolvedValue(FREE);
    const { result } = renderHook();
    expect(result.current).toBeNull();
    await act(async () => {});
    expect(result.current).toEqual(FREE);
  });

  it('reads again when the app comes back to the foreground', async () => {
    mockAllowance.mockResolvedValue(FREE);
    let onChange: (s: string) => void = () => {};
    (AppState.addEventListener as jest.Mock).mockImplementation(((_: string, cb: (s: string) => void) => {
      onChange = cb;
      return { remove: jest.fn() };
    }) as never);
    renderHook();
    await act(async () => {});
    const before = mockAllowance.mock.calls.length;
    mockAllowance.mockResolvedValue({ ...FREE, used: 3, remaining: 2 });
    await act(async () => onChange('active'));
    expect(mockAllowance.mock.calls.length).toBe(before + 1);
    expect(useAllowanceStore.getState().status?.remaining).toBe(2);
  });

  it('reads again when a recording ends, and not when it starts', async () => {
    mockAllowance.mockResolvedValue(FREE);
    renderHook();
    await act(async () => {});
    const before = mockAllowance.mock.calls.length;
    await act(async () => useRecordingStore.setState({ isRecording: true }));
    expect(mockAllowance.mock.calls.length).toBe(before);
    mockAllowance.mockResolvedValue({ ...FREE, used: 3, remaining: 2 });
    await act(async () => useRecordingStore.setState({ isRecording: false }));
    expect(mockAllowance.mock.calls.length).toBe(before + 1);
    expect(useAllowanceStore.getState().status?.remaining).toBe(2);
  });
});
