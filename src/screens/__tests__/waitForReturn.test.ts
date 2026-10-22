import { watchForReturn, type AppStateLike } from '../waitForReturn';

function fake(currentState = 'active') {
  let cb: ((s: string) => void) | null = null;
  const remove = jest.fn();
  const appState: AppStateLike = {
    currentState,
    addEventListener: (_t, l) => {
      cb = l;
      return { remove };
    },
  };
  return {
    appState,
    emit: (s: string) => {
      appState.currentState = s;
      cb?.(s);
    },
    remove,
  };
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

test('already out of the foreground when the watch starts: pending until the app is active again', async () => {
  const f = fake('background');
  const p = watchForReturn(f.appState, 1000);
  jest.advanceTimersByTime(60000);
  expect(await settled(p)).toBe(false);
  f.emit('active');
  expect(await settled(p)).toBe(true);
  expect(f.remove).toHaveBeenCalled();
});

test('leaves after the watch started: resolves only on the return', async () => {
  const f = fake();
  const p = watchForReturn(f.appState, 1000);
  jest.advanceTimersByTime(500);
  f.emit('inactive');
  jest.advanceTimersByTime(5000);
  expect(await settled(p)).toBe(false);
  f.emit('active');
  expect(await settled(p)).toBe(true);
});

test('never leaves: carries on once the window has passed', async () => {
  const f = fake();
  const p = watchForReturn(f.appState, 1000);
  jest.advanceTimersByTime(999);
  expect(await settled(p)).toBe(false);
  jest.advanceTimersByTime(1);
  expect(await settled(p)).toBe(true);
  expect(f.remove).toHaveBeenCalled();
});
