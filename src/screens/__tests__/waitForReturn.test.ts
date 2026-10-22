import { waitForReturn, type AppStateLike } from '../waitForReturn';

function fake() {
  let cb: ((s: string) => void) | null = null;
  const remove = jest.fn();
  const appState: AppStateLike = {
    addEventListener: (_t, l) => {
      cb = l;
      return { remove };
    },
  };
  return { appState, emit: (s: string) => cb?.(s), remove };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const settled = async (p: Promise<void>) => {
  let done = false;
  p.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
};

test('no departure within the window: carries on', async () => {
  const f = fake();
  const p = waitForReturn(f.appState, 1000);
  jest.advanceTimersByTime(1000);
  expect(await settled(p)).toBe(true);
  expect(f.remove).toHaveBeenCalled();
});

test('departs then returns: resolves only after the return', async () => {
  const f = fake();
  const p = waitForReturn(f.appState, 1000);
  f.emit('inactive');
  jest.advanceTimersByTime(5000);
  expect(await settled(p)).toBe(false);
  f.emit('active');
  expect(await settled(p)).toBe(true);
  expect(f.remove).toHaveBeenCalled();
});

test('departs and has not returned: still pending', async () => {
  const f = fake();
  const p = waitForReturn(f.appState, 1000);
  f.emit('background');
  jest.advanceTimersByTime(60000);
  expect(await settled(p)).toBe(false);
});
