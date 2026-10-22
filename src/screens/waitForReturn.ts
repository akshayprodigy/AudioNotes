export type AppStateLike = {
  currentState: unknown;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
};

/**
 * Starts watching NOW (call it before opening a system dialog) and returns a promise that
 * resolves once the app is back in the foreground. If the app is already away at the start, or
 * leaves later, it waits for 'active'. If it never leaves within leaveWindowMs (nothing was shown,
 * e.g. already exempt) it resolves anyway.
 */
export function watchForReturn(appState: AppStateLike, leaveWindowMs = 2000): Promise<void> {
  return new Promise<void>(resolve => {
    // Only a real string state counts: before RN reports one it is null/undefined (or a mock).
    let left = typeof appState.currentState === 'string' && appState.currentState !== 'active';
    const finish = () => {
      clearTimeout(timer);
      sub.remove();
      resolve();
    };
    const sub = appState.addEventListener('change', state => {
      if (state !== 'active') {
        left = true;
        clearTimeout(timer);
      } else if (left) {
        finish();
      }
    });
    const timer = setTimeout(() => {
      if (!left) finish();
    }, leaveWindowMs);
  });
}
