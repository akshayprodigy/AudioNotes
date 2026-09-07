/**
 * Crash reporting, for an app whose promise is that the user's meeting never leaves the phone.
 *
 * That promise is about the meeting: the audio, the transcript, who spoke, the minutes. None of it
 * can reach here. What Crashlytics sends is a stack trace, the app version, and the model of phone
 * it happened on — after somebody has said yes.
 *
 * Why it exists at all: the risky half of this app is native — whisper.cpp, llama.cpp, sherpa-onnx
 * and the JNI layer between them, minified by R8. When that segfaults on a phone we do not own
 * there is no logcat to read and no reproduction to run. The alternative to crash reporting is not
 * privacy, it is debugging from one-star reviews.
 *
 * Three rules this file exists to keep:
 *
 *   1. Off unless asked for. Collection is disabled in AndroidManifest.xml, which is the only
 *      switch that works before any JavaScript runs, and enabled here only once consent is stored.
 *   2. No content, ever. Nothing in this file passes app data to Crashlytics — no user id, no
 *      custom keys, no logs. `recordError` is deliberately not re-exported, because the moment a
 *      caller can hand it an Error it can hand it an Error containing a transcript line.
 *   3. Revocable, and revoked means stopped — not merely un-sent.
 *
 * WHAT CHANGED WHEN THIS MOVED OFF SENTRY, and it is a real loss worth stating rather than
 * discovering: Sentry exposed a `beforeSend` hook, so the previous version stripped the user,
 * request, server name and message off every event, and recorded the exact serialised byte count
 * in the privacy ledger. Crashlytics has no such hook. Reports are assembled and uploaded by
 * native Play Services code that this app cannot inspect, intercept or measure.
 *
 * Two consequences follow, and both are handled rather than hoped about:
 *   - Scrubbing is now a matter of never GIVING Crashlytics anything to leak, instead of removing
 *     it afterwards. Hence rule 2 being about what this file refuses to call.
 *   - The privacy screen can no longer count these bytes, so it names Crashlytics as a source it
 *     cannot count — the same treatment it already gives Google Play's own connection. An
 *     uncounted source that is disclosed is honest; an uncounted source that is not is the exact
 *     overclaim that screen was built to prevent.
 */
import {
  getCrashlytics,
  setCrashlyticsCollectionEnabled,
} from '@react-native-firebase/crashlytics';

import { db } from '../db/queries';
import { CRASH_REPORTING_BUILD } from './enabled';

/** Settings key holding 'on' | 'off'. Absent means never asked. */
export const CRASH_CONSENT_KEY = 'crash_reports';

/** Whether the build can report crashes at all. False in development. */
export function crashReportingAvailable(): boolean {
  return CRASH_REPORTING_BUILD;
}

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

/** Record the answer and start or stop collection to match it. */
export async function setCrashConsent(on: boolean): Promise<void> {
  if (!crashReportingAvailable()) return;
  try {
    await db.setSetting(CRASH_CONSENT_KEY, on ? 'on' : 'off');
  } catch {
    // Nothing useful to do — but never start collecting off the back of a write we could not make.
    return;
  }
  await apply(on);
}

/**
 * Match collection to the stored answer. Called on launch after the store opens.
 *
 * Called with `false` as well as `true`, deliberately. Crashlytics persists this flag across
 * launches, so a build that only ever enabled it would leave collection on for somebody who had
 * withdrawn consent in a previous session and never opened Settings again.
 */
export async function initCrashReporting(): Promise<void> {
  if (!crashReportingAvailable()) return;
  await apply((await crashConsent()) === 'on');
}

async function apply(on: boolean): Promise<void> {
  try {
    await setCrashlyticsCollectionEnabled(getCrashlytics(), on);
  } catch {
    // A failure here must not take the app down on launch. The manifest default is off, so the
    // safe state is also the default state: worst case, crashes go unreported.
  }
}
