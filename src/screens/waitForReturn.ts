export type AppStateLike = {
  currentState: string | null | undefined;
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
    // null/undefined = RN has not reported a state yet; that is not evidence of having left.
    let left = appState.currentState != null && appState.currentState !== 'active';
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
