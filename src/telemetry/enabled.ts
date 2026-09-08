/**
 * Whether this build may report crashes at all.
 *
 * Firebase is configured by `android/app/google-services.json`, which is committed, so unlike the
 * Sentry DSN this replaced there is no "not configured" state to fall back on. The off switch is
 * therefore explicit and lives here.
 *
 * Debug builds never report. A crash while somebody is developing is one they can already see in
 * the terminal, and reporting it only makes the production signal harder to read.
 */
export const CRASH_REPORTING_BUILD = !__DEV__;
