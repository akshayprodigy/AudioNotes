export type AppStateLike = {
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
};

/**
 * Resolves once the app has come back from a system dialog it just opened. If the app does not
 * leave 'active' within leaveWindowMs (nothing was shown, e.g. already exempt) it resolves anyway.
 * If it does leave, it waits for 'active' again.
 */
export function waitForReturn(appState: AppStateLike, leaveWindowMs = 1000): Promise<void> {
  return new Promise<void>(resolve => {
    let left = false;
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
