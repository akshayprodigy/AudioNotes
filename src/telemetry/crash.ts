/**
 * Crash reporting, for an app whose entire promise is that nothing leaves the phone.
 *
 * That promise is about the meeting: the audio, the transcript, who spoke, the minutes. None of
 * that is ever uploaded and none of it can reach here — see the scrubbing below, which is written
 * to be provably content-free rather than merely careful. What this sends is a stack trace and
 * the model of phone it happened on, and only after somebody has said yes.
 *
 * Why it exists at all: the risky half of this app is native — whisper.cpp, llama.cpp,
 * sherpa-onnx and the JNI layer between them, minified by R8. When that segfaults on a phone we
 * do not own, there is no logcat to read and no reproduction to run. The alternative to crash
 * reporting is not privacy, it is debugging from one-star reviews.
 *
 * Three rules this file exists to keep:
 *
 *   1. Off unless asked for. Consent is stored, checked before start(), and revocable.
 *   2. No content, ever. Screenshots and view hierarchies are explicitly disabled — Sentry can
 *      attach both, and on this app a screenshot IS the transcript. Breadcrumbs that could carry
 *      text are dropped.
 *   3. No DSN, no SDK. An empty dsn.ts makes every function here a no-op.
 */
import * as Sentry from '@sentry/react-native';

import { db } from '../db/queries';
import { SENTRY_DSN } from './dsn';

/** Settings key holding 'on' | 'off'. Absent means never asked. */
export const CRASH_CONSENT_KEY = 'crash_reports';

/** Whether the build can report crashes at all. False with no DSN, which is the default. */
export function crashReportingAvailable(): boolean {
  return SENTRY_DSN.length > 0;
}

let started = false;

/**
 * 'on' | 'off' | null, where null means the question has not been put to them yet.
 *
 * Read through the encrypted store rather than a second storage layer: consent about what leaves
 * the device belongs with the rest of the user's settings, not beside them.
 */
export async function crashConsent(): Promise<'on' | 'off' | null> {
  if (!crashReportingAvailable()) return 'off';
  try {
    const v = await db.getSetting(CRASH_CONSENT_KEY);
    return v === 'on' || v === 'off' ? v : null;
  } catch {
    // A store that will not open is not consent.
    return null;
  }
}

/** Record the answer and start or stop the SDK to match it. */
export async function setCrashConsent(on: boolean): Promise<void> {
  if (!crashReportingAvailable()) return;
  try {
    await db.setSetting(CRASH_CONSENT_KEY, on ? 'on' : 'off');
  } catch {
    // Nothing useful to do — but never start the SDK off the back of a write we could not make.
    return;
  }
  if (on) start();
  else stop();
}

/**
 * Start the SDK if, and only if, it is available and consented.
 *
 * Called on launch after the store opens. Native crash handling installs when this runs, which
 * means the first moments of a cold start are not covered — an acceptable trade for keeping one
 * settings store, given the code that actually crashes is the pipeline, minutes into a session.
 */
export async function initCrashReporting(): Promise<void> {
  if ((await crashConsent()) === 'on') start();
}

function stop(): void {
  if (!started) return;
  // close() ends the client; a later start() builds a fresh one.
  Sentry.close();
  started = false;
}

function start(): void {
  if (started || !crashReportingAvailable()) return;
  started = true;

  Sentry.init({
    dsn: SENTRY_DSN,

    // Native crashes are the reason this is here. Without it, a segfault inside the C++ core —
    // the most likely and least debuggable failure this app has — reports nothing.
    enableNative: true,

    // A screenshot of this app is a transcript of somebody's meeting. The view hierarchy is the
    // same content with the pixels removed. Both are opt-in features of the SDK and both stay off
    // permanently; there is no diagnostic worth uploading a customer's minutes for.
    attachScreenshot: false,
    attachViewHierarchy: false,

    // No IP address, no device name, no username. sendDefaultPii false is the switch that stops
    // Sentry inferring a user from the request; the scrubbing in beforeSend is the belt to its
    // braces, because a default can change in a minor version and a delete cannot.
    sendDefaultPii: false,

    // Performance tracing records URLs, route names and timings on every interaction. It is a
    // continuous telemetry stream, which is a different bargain from "tell us when it broke", and
    // not one this app asked for.
    tracesSampleRate: 0,
    enableAutoPerformanceTracing: false,

    // Sessions report app foreground/background as a heartbeat. Harmless in content and still a
    // steady trickle of traffic from an app that tells people it does not use the network.
    enableAutoSessionTracking: false,

    // Enough to see the last few screens, not enough to reconstruct a session.
    maxBreadcrumbs: 20,

    beforeBreadcrumb(crumb) {
      // Console and network breadcrumbs are the two that carry free text — a console.log of a
      // transcript line, or a URL with a meeting id in it. Navigation is a screen name, which is
      // what makes a stack trace readable, so that one stays.
      if (crumb.category === 'navigation') return crumb;
      return null;
    },

    beforeSend(event) {
      // Everything that could identify a person or a machine, removed after the SDK has built the
      // event and before it is queued. Deleting is deliberate: an allow-list of fields would
      // silently start passing anything a future SDK version adds.
      delete event.user;
      delete event.request;
      delete event.server_name;
      delete event.extra;
      if (event.contexts?.device) {
        delete event.contexts.device.name;
        delete event.contexts.device.device_unique_identifier;
      }
      // Strip the message body. Exceptions carry their type and stack, which is the whole point;
      // a captureMessage string is free text and there is no way to be sure what got put in it.
      delete event.message;
      delete event.logentry;
      return event;
    },
  });
}
