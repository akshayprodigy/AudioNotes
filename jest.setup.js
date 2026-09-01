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
    reindex: jest.fn(async () => {}),
    backfillSearch: jest.fn(async () => 0),
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
jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter', () => ({
  __esModule: true,
  default: class MockNativeEventEmitter {
    addListener() {
      return {remove: jest.fn()};
    }
    removeAllListeners() {}
    emit() {}
  },
}));

// Sentry ships ESM, which this project's transformIgnorePatterns deliberately does not transform.
// Mocking is the right answer anyway rather than adding it to that list: no test wants a real
// crash SDK initialised, and transforming the package on every run would cost seconds for
// something whose behaviour under test should be "was init called", not "did it network".
jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  close: jest.fn(),
  captureException: jest.fn(),
}));

global.__TEST_NATIVE_MODULES__ = mockNativeModules;
