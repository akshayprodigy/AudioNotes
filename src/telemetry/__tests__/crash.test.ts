/**
 * The consent gate on crash reporting.
 *
 * This is the only code in the app that can cause a network request the user did not ask for, so
 * the tests that matter are not "does Crashlytics work" — that is Google's job — but "can
 * collection ever be switched on without a yes", which is ours.
 *
 * Moving off Sentry narrowed what is testable here and widened what matters. There is no longer a
 * beforeSend hook to assert scrubbing against, because Crashlytics has none: reports are built and
 * uploaded by native code this app cannot inspect. Safety is therefore no longer "we strip the
 * dangerous fields" but "we never hand it anything to leak", and the one lever left — the
 * collection flag — carries all the weight. Hence every one of these.
 *
 * Every test loads the module fresh, because consent is read through a store the mock resets.
 */
type CrashModule = typeof import('../crash');

const crashlytics = (global as unknown as {
  __TEST_CRASHLYTICS__: { setCrashlyticsCollectionEnabled: jest.Mock };
}).__TEST_CRASHLYTICS__;

/** A fresh copy of the module, bound to a build that may or may not report at all. */
function load(enabled = true): CrashModule {
  jest.resetModules();
  jest.doMock('../enabled', () => ({ CRASH_REPORTING_BUILD: enabled }));
  return require('../crash') as CrashModule;
}

const StorageMock = (global as unknown as {
  __TEST_NATIVE_MODULES__: Record<string, Record<string, jest.Mock>>;
}).__TEST_NATIVE_MODULES__.Storage;

const settings = new Map<string, string>();
const KEY = 'crash_reports';

/** What collection was last set to, or undefined if it was never touched. */
const lastSetting = (): boolean | undefined => {
  const calls = crashlytics.setCrashlyticsCollectionEnabled.mock.calls;
  return calls.length ? (calls[calls.length - 1][0] as boolean) : undefined;
};

beforeEach(() => {
  settings.clear();
  jest.clearAllMocks();
  StorageMock.query.mockImplementation(async (sql: string, argsJson: string) => {
    const args = JSON.parse(argsJson) as string[];
    if (sql.startsWith('SELECT value FROM settings')) {
      const v = settings.get(args[0]);
      return JSON.stringify(v === undefined ? [] : [{ value: v }]);
    }
    if (sql.startsWith('INSERT OR REPLACE INTO settings')) {
      settings.set(args[0], String(args[1]));
      return '[]';
    }
    return '[]';
  });
});

describe('consent', () => {
  it('is null until the question has been answered', async () => {
    expect(await load().crashConsent()).toBeNull();
  });

  it('does not enable collection on launch when nobody has answered', async () => {
    await load().initCrashReporting();
    expect(lastSetting()).toBe(false);
  });

  it('does not enable collection on launch when the answer was no', async () => {
    settings.set(KEY, 'off');
    await load().initCrashReporting();
    expect(lastSetting()).toBe(false);
  });

  it('enables collection on launch when the answer was yes', async () => {
    settings.set(KEY, 'on');
    await load().initCrashReporting();
    expect(lastSetting()).toBe(true);
  });

  it('records the answer so it survives a restart', async () => {
    await load().setCrashConsent(true);
    expect(settings.get(KEY)).toBe('on');
    expect(lastSetting()).toBe(true);
  });

  it('disables collection when consent is withdrawn', async () => {
    settings.set(KEY, 'on');
    await load().setCrashConsent(false);
    expect(settings.get(KEY)).toBe('off');
    expect(lastSetting()).toBe(false);
  });

  it('turns collection off on launch after a withdrawal, not merely leaving it alone', async () => {
    // Crashlytics persists this flag natively across launches. A build that only ever enabled it
    // would keep reporting for somebody who said no once and never opened Settings again.
    settings.set(KEY, 'off');
    await load().initCrashReporting();
    expect(crashlytics.setCrashlyticsCollectionEnabled).toHaveBeenCalledWith(false);
  });

  it('treats a store that will not open as "not asked", never as yes', async () => {
    StorageMock.query.mockRejectedValue(new Error('locked'));
    const crash = load();
    expect(await crash.crashConsent()).toBeNull();
    await crash.initCrashReporting();
    expect(lastSetting()).toBe(false);
  });

  it('does not enable collection when the consent write fails', async () => {
    StorageMock.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('INSERT OR REPLACE INTO settings')) throw new Error('disk full');
      return '[]';
    });
    await load().setCrashConsent(true);
    expect(crashlytics.setCrashlyticsCollectionEnabled).not.toHaveBeenCalled();
  });

  it('survives Crashlytics throwing, rather than taking the launch down with it', async () => {
    crashlytics.setCrashlyticsCollectionEnabled.mockRejectedValueOnce(new Error('no play services'));
    settings.set(KEY, 'on');
    await expect(load().initCrashReporting()).resolves.toBeUndefined();
  });
});

describe('a build with reporting switched off', () => {
  it('reports itself unavailable and never touches the SDK', async () => {
    const crash = load(false);
    expect(crash.crashReportingAvailable()).toBe(false);
    expect(await crash.crashConsent()).toBe('off');
    await crash.initCrashReporting();
    await crash.setCrashConsent(true);
    expect(crashlytics.setCrashlyticsCollectionEnabled).not.toHaveBeenCalled();
    expect(settings.get(KEY)).toBeUndefined();
  });
});

it('is available in a build with reporting switched on', () => {
  expect(load(true).crashReportingAvailable()).toBe(true);
});
