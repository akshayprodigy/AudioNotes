/**
 * The numbers on the privacy screen, derived from the ledger and nothing else.
 *
 * Pure on purpose. The screen's credibility rests on these figures being a function of what was
 * recorded, so there is no clock, no store and no I/O in here — `now` is passed in, which is also
 * what makes the month boundary testable rather than something that breaks once a month.
 */

/** The kinds of egress this app has. There is deliberately no 'audio'. */
export type NetworkKind = 'licence' | 'models' | 'crash';

export interface NetworkEvent {
  id: number;
  at: number;
  kind: NetworkKind;
  host: string;
  /** Request BODY bytes. Headers are excluded — see the screen's footnote. */
  sent: number;
  received: number;
  detail: string | null;
}

export interface PrivacySummary {
  callsThisMonth: number;
  sentThisMonth: number;
  receivedThisMonth: number;
  /** The one-time model download, over all time: it is setup, not monthly traffic. */
  setupDownloadBytes: number;
  setupHosts: string[];
  allHosts: string[];
  /**
   * Always 0, and derived rather than printed. `NetworkKind` has no audio member, so no caller
   * can record one — the zero is a consequence of the type, which is a stronger claim than a
   * constant on a screen.
   */
  audioBytes: number;
}

function startOfMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function summarise(events: NetworkEvent[], now: number): PrivacySummary {
  const since = startOfMonth(now);
  const month = events.filter(e => e.at >= since);
  const setup = events.filter(e => e.kind === 'models');

  return {
    callsThisMonth: month.length,
    sentThisMonth: month.reduce((n, e) => n + e.sent, 0),
    receivedThisMonth: month.reduce((n, e) => n + e.received, 0),
    setupDownloadBytes: setup.reduce((n, e) => n + e.received, 0),
    setupHosts: [...new Set(setup.map(e => e.host))].sort(),
    allHosts: [...new Set(events.map(e => e.host))].sort(),
    audioBytes: 0,
  };
}

/** Bytes as a person reads them. Deliberately not exact — the log carries the exact figure. */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} bytes`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(1)} GB`;
}
