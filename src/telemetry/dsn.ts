/**
 * The Sentry DSN, and the only line you edit to turn crash reporting on.
 *
 * Empty is not a broken state. An empty DSN disables crash reporting completely — no SDK start,
 * no consent row in Settings, no question during setup — so the app ships and behaves correctly
 * with this file exactly as it is. Paste the DSN from your Sentry project to switch it on.
 *
 * A DSN is a public identifier, not a secret: it is embedded in every copy of every app that
 * uses Sentry, and it only permits writing events into one project. It is committed here for the
 * same reason the model URLs are — a build should not need a private file to be reproducible.
 * The token that can *read* your Sentry data is a different thing and never belongs in this repo.
 */
export const SENTRY_DSN = '';
