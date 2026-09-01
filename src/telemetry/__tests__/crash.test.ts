/**
 * The consent gate on crash reporting.
 *
 * This is the only code in the app that can cause a network request the user did not ask for, in
 * a product sold on the promise that there are none. The tests that matter are therefore not
 * "does Sentry work" — that is Sentry's job — but "can the SDK ever start without a yes", which
 * is ours, and which has exactly three ways to go wrong: no DSN, no answer, and a revoked answer.
 *
 * Every test loads the module fresh. crash.ts keeps a module-level `started` flag so a second
 * start() is a no-op — correct in the app, where the module lives as long as the process, and a
 * trap in a test file, where a leftover `true` from an earlier case would silently stop init from
 * being called and turn a real regression into a green run.
 */
const DSN = 'https://examplekey@o0.ingest.sentry.io/1';

type CrashModule = typeof import('../crash');
type SentryMock = { init: jest.Mock; close: jest.Mock };

/** A fresh copy of the module, and the Sentry mock that copy is bound to. */
function load(dsn: string = DSN): { crash: CrashModule; sentry: SentryMock } {
  jest.resetModules();
  jest.doMock('../dsn', () => ({ SENTRY_DSN: dsn }));
  return {
    crash: require('../crash') as CrashModule,
    sentry: require('@sentry/react-native') as SentryMock,
  };
}

// Named StorageMock, not Storage: this file has no top-level import, so TypeScript treats it as a
// script rather than a module, and a bare `Storage` collides with the DOM lib's global type.
const StorageMock = (global as unknown as {
  __TEST_NATIVE_MODULES__: Record<string, Record<string, jest.Mock>>;
}).__TEST_NATIVE_MODULES__.Storage;

const settings = new Map<string, string>();
const KEY = 'crash_reports';

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
    const { crash } = load();
    expect(await crash.crashConsent()).toBeNull();
  });

  it('does not start the SDK on launch when nobody has answered', async () => {
    const { crash, sentry } = load();
    await crash.initCrashReporting();
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it('does not start the SDK on launch when the answer was no', async () => {
    settings.set(KEY, 'off');
    const { crash, sentry } = load();
    await crash.initCrashReporting();
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it('starts the SDK on launch when the answer was yes', async () => {
    settings.set(KEY, 'on');
    const { crash, sentry } = load();
    await crash.initCrashReporting();
    expect(sentry.init).toHaveBeenCalledTimes(1);
  });

  it('records the answer so it survives a restart', async () => {
    const { crash } = load();
    await crash.setCrashConsent(true);
    expect(settings.get(KEY)).toBe('on');
    await crash.setCrashConsent(false);
    expect(settings.get(KEY)).toBe('off');
  });

  it('closes the SDK when consent is withdrawn', async () => {
    settings.set(KEY, 'on');
    const { crash, sentry } = load();
    await crash.initCrashReporting();
    await crash.setCrashConsent(false);
    expect(sentry.close).toHaveBeenCalledTimes(1);
  });

  it('treats a store that will not open as "not asked", never as yes', async () => {
    StorageMock.query.mockRejectedValue(new Error('locked'));
    const { crash, sentry } = load();
    expect(await crash.crashConsent()).toBeNull();
    await crash.initCrashReporting();
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it('does not start the SDK when the consent write fails', async () => {
    // Starting off the back of a yes we could not record would leave the SDK running with no way
    // for the user to find the switch that turns it off again.
    const { crash, sentry } = load();
    StorageMock.query.mockRejectedValue(new Error('disk full'));
    await crash.setCrashConsent(true);
    expect(sentry.init).not.toHaveBeenCalled();
  });
});

describe('the SDK options', () => {
  /** The options object crash.ts hands to Sentry.init, with consent already granted. */
  async function options(): Promise<Record<string, any>> {
    settings.set(KEY, 'on');
    const { crash, sentry } = load();
    await crash.initCrashReporting();
    return sentry.init.mock.calls[0][0];
  }

  it('never attaches a screenshot or the view hierarchy', async () => {
    // A screenshot of this app is somebody's transcript. Both are opt-in SDK features and both
    // must stay off; this test is here so that turning one on has to be deliberate.
    const opts = await options();
    expect(opts.attachScreenshot).toBe(false);
    expect(opts.attachViewHierarchy).toBe(false);
    expect(opts.sendDefaultPii).toBe(false);
    expect(opts.tracesSampleRate).toBe(0);
    expect(opts.enableAutoSessionTracking).toBe(false);
  });

  it('strips the fields that could identify a person or a phone', async () => {
    const opts = await options();
    const event = opts.beforeSend({
      user: { id: 'someone', email: 'a@b.c' },
      request: { url: 'https://example.test/x' },
      server_name: 'a-phone',
      message: 'transcript line that should never travel',
      extra: { transcript: 'nor this' },
      contexts: { device: { name: "somebody's Pixel", model: 'Pixel 7 Pro' } },
      exception: { values: [{ type: 'SIGSEGV' }] },
    });
    expect(event.user).toBeUndefined();
    expect(event.request).toBeUndefined();
    expect(event.server_name).toBeUndefined();
    expect(event.message).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.contexts.device.name).toBeUndefined();
    // What is left is the part that makes a crash fixable.
    expect(event.contexts.device.model).toBe('Pixel 7 Pro');
    expect(event.exception.values[0].type).toBe('SIGSEGV');
  });

  it('survives an event with no device context', async () => {
    const opts = await options();
    expect(() => opts.beforeSend({ exception: { values: [] } })).not.toThrow();
  });

  it('drops every breadcrumb that could carry free text', async () => {
    const opts = await options();
    expect(opts.beforeBreadcrumb({ category: 'console', message: 'a transcript' })).toBeNull();
    expect(opts.beforeBreadcrumb({ category: 'http', data: { url: '/meeting/9' } })).toBeNull();
    expect(opts.beforeBreadcrumb({ category: 'xhr' })).toBeNull();
    // Screen names are what make a stack trace readable and carry nothing of the meeting.
    expect(opts.beforeBreadcrumb({ category: 'navigation' })).not.toBeNull();
  });
});

describe('with no DSN configured', () => {
  it('reports itself unavailable and cannot start', async () => {
    const { crash, sentry } = load('');
    expect(crash.crashReportingAvailable()).toBe(false);
    await crash.initCrashReporting();
    await crash.setCrashConsent(true);
    expect(sentry.init).not.toHaveBeenCalled();
    // And it must not have written a consent row for a thing that cannot happen.
    expect(settings.get(KEY)).toBeUndefined();
  });
});

it('is available when a DSN is configured', () => {
  expect(load().crash.crashReportingAvailable()).toBe(true);
});
