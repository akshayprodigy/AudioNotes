/**
 * Jest setup — stubs the six TurboModules so JS-layer tests can render screens
 * without a native binary. Each stub mirrors the matching `src/native/Native*.ts`
 * spec; the real implementations live in android/.../pipeline (and ios/ later).
 *
 * Keep these in sync with the specs: an added spec method that is missing here
 * surfaces as `undefined is not a function` inside a component test, not as a
 * clear error.
 *
 * The `mock` prefix is required — jest hoists `jest.mock()` factories above the
 * file, and only `mock*` variables may be referenced from inside one.
 */

const mockNativeModules = {
  AudioPipeline: {
    start: jest.fn(async () => 'test-session'),
    stop: jest.fn(async () => {}),
    process: jest.fn(async () => {}),
    cancel: jest.fn(),
    requestBatteryExemption: jest.fn(async () => true),
    recoverOrphans: jest.fn(async () => 0),
    consumePendingMeetingId: jest.fn(async () => null),
    discardAudio: jest.fn(async () => {}),
    setPaused: jest.fn(async () => {}),
    sweepAudioRetention: jest.fn(async () => 0),
    currentSession: jest.fn(async () => ({
      isRecording: false, meetingId: null, elapsedMs: 0, silenced: false, paused: false,
    })),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
  Storage: {
    open: jest.fn(async () => {}),
    // The typed db layer in src/db parses this, so return a valid empty result set.
    query: jest.fn(async () => '[]'),
    search: jest.fn(async () => '[]'),
    // A safe default: a screen that forgets to mock this sees the paywall, not data.
    thread: jest.fn(async () => '{"refusal":"NOT_PRO"}'),
    reindex: jest.fn(async () => {}),
    // The meeting screen awaits this before its first read; a missing stub is an unhandled
    // rejection inside a component, not a clear error.
    ensureItems: jest.fn(async () => {}),
    backfillSearch: jest.fn(async () => 0),
    // Resolves 0 = "nothing left to migrate", so LibraryScreen's focus sweep stops after one pass
    // instead of looping four hundred times in every screen test that renders the library.
    backfillItems: jest.fn(async () => 0),
  },
  ModelManager: {
    list: jest.fn(async () => '[]'),
    download: jest.fn(async () => {}),
    remove: jest.fn(async () => {}),
    verify: jest.fn(async () => true),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
  FileExport: {
    share: jest.fn(async () => {}),
    render: jest.fn(async () => '# Test meeting\n'),
    copy: jest.fn(async () => {}),
  },
  Import: {
    pick: jest.fn(async () => null),
    importUri: jest.fn(async () => 'imported-meeting'),
    consumePendingImport: jest.fn(async () => null),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
  Player: {
    hasAudio: jest.fn(async () => false),
    open: jest.fn(async () => ({ durationMs: 0 })),
    play: jest.fn(async () => {}),
    pause: jest.fn(async () => {}),
    seek: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
  Llm: {
    // Default to "no LLM" so tests exercise the rule-based floor, which is the
    // guaranteed path in production too.
    available: jest.fn(async () => false),
    capable: jest.fn(async () => false),
    load: jest.fn(async () => false),
    generate: jest.fn(async () => ''),
    unload: jest.fn(async () => {}),
  },
  Backup: {
    exportAndShare: jest.fn(async () => 'audionotes-test.anbak'),
    pickAndRestore: jest.fn(async () => null),
  },
  Billing: {
    available: jest.fn().mockResolvedValue(false),
    price: jest.fn().mockResolvedValue(null),
    purchase: jest.fn().mockResolvedValue(null),
    restore: jest.fn().mockResolvedValue(null),
    acknowledgeLocally: jest.fn().mockResolvedValue(true),
  },
  Licence: {
    // Default to an active subscription, matching a development build: with no licence key
    // configured the app unlocks, and tests should exercise the path most code takes.
    status: jest.fn(async () => ({
      plan: 'unlicensed-build',
      state: 'active',
      paid: true,
      expiresAt: 0,
      account: null,
      lapsedCopy: 'Your subscription has ended.',
    })),
    store: jest.fn(async () => true),
    refreshKey: jest.fn(async () => null),
    // No server in tests, so sign-in is unavailable and refreshIfNeeded is a no-op.
    baseUrl: jest.fn(async () => ''),
    clear: jest.fn(async () => {}),
    deviceId: jest.fn(async () => 'test-device'),
  },
  Pip: {
    isSupported: jest.fn(async () => false),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
};

// Intercept only OUR modules; everything else (PlatformConstants, DeviceInfo, …)
// must fall through to the real registry, which the RN jest preset already handles.
jest.mock('react-native/Libraries/TurboModule/TurboModuleRegistry', () => {
  const actual = jest.requireActual(
    'react-native/Libraries/TurboModule/TurboModuleRegistry',
  );
  return {
    ...actual,
    get: name => mockNativeModules[name] ?? actual.get(name),
    getEnforcing: name => mockNativeModules[name] ?? actual.getEnforcing(name),
  };
});

// NativeEventEmitter is constructed at import time by PipelineController and would
// otherwise assert on a null native module. It is an ESM default export, so the
// mock has to preserve that shape.
jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter', () => {
  // One registry for every instance: PipelineController's emitter is built at import time and
  // AudioPipeline.addListener callers build their own, and a test wants to reach all of them.
  // `global.__TEST_EMIT__(name, payload)` is how a screen test delivers a native event.
  const listeners = new Map();
  class MockNativeEventEmitter {
    addListener(name, cb) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(cb);
      return {remove: () => listeners.get(name)?.delete(cb)};
    }
    removeAllListeners(name) {
      listeners.delete(name);
    }
    emit(name, payload) {
      for (const cb of listeners.get(name) ?? []) cb(payload);
    }
  }
  global.__TEST_EMIT__ = (name, payload) => new MockNativeEventEmitter().emit(name, payload);
  return {__esModule: true, default: MockNativeEventEmitter};
});

// Crashlytics is a native module with no JS fallback, so it throws the moment it is touched under
// Jest. Mocking is the right answer regardless: no test wants a real crash SDK, and what these
// tests assert is "was collection enabled, and only after a yes" — not that Google received
// anything. One shared mock so a test can read the calls back.
// Prefixed `mock` because Jest forbids a mock factory from closing over anything else.
const mockCrashlytics = {
  setCrashlyticsCollectionEnabled: jest.fn(() => Promise.resolve()),
};
jest.mock('@react-native-firebase/crashlytics', () => ({
  __esModule: true,
  getCrashlytics: () => ({}),
  setCrashlyticsCollectionEnabled: (_app, enabled) =>
    mockCrashlytics.setCrashlyticsCollectionEnabled(enabled),
}));
global.__TEST_CRASHLYTICS__ = mockCrashlytics;

global.__TEST_NATIVE_MODULES__ = mockNativeModules;
