import { db } from '../db/queries';
import type { NetworkEvent, NetworkKind } from './summary';

/**
 * The only way anything is written to the network ledger.
 *
 * One function because the screen's claim is "this is every byte", and that is only defensible
 * while there is a single place a byte can be recorded from. The four callers are the four call
 * sites that own this app's entire network access; `scripts/check-network-egress.py` fails the
 * build if a fifth appears.
 */

/** Settings key counting events we failed to write. Shown on the screen when non-zero. */
export const DROPS_KEY = 'network_ledger_drops';

export interface Egress {
  kind: NetworkKind;
  host: string;
  /** Request BODY bytes. Headers are excluded, and the screen says so. */
  sent: number;
  received: number;
  detail: string | null;
}

/**
 * Record one egress event. Never throws.
 *
 * A recording failure must not break the call being recorded — a licence refresh that failed
 * because the ledger was locked would be an absurd way to lose. But it must not vanish either: a
 * ledger that silently drops rows reads LOW, and a privacy screen that under-reports is worse
 * than no privacy screen. So a failure is counted and surfaced instead.
 */
export async function record(e: Egress): Promise<void> {
  try {
    await db.query(
      'INSERT INTO network_events(at, kind, host, sent, received, detail) VALUES(?, ?, ?, ?, ?, ?)',
      [Date.now(), e.kind, e.host, e.sent, e.received, e.detail],
    );
  } catch {
    try {
      const current = Number((await db.getSetting(DROPS_KEY)) ?? '0') || 0;
      await db.setSetting(DROPS_KEY, String(current + 1));
    } catch {
      // Both the ledger and the settings store are unavailable. Nothing further is possible
      // here, and throwing would take a network call down with it.
    }
  }
}

/** How many events could not be written. The screen says so rather than reading low in silence. */
export async function drops(): Promise<number> {
  try {
    return Number((await db.getSetting(DROPS_KEY)) ?? '0') || 0;
  } catch {
    return 0;
  }
}

/** The whole ledger, newest first. */
export async function events(): Promise<NetworkEvent[]> {
  try {
    return await db.query<NetworkEvent>(
      'SELECT id, at, kind, host, sent, received, detail FROM network_events ORDER BY at DESC',
    );
  } catch {
    return [];
  }
}

/** Host from a URL, or the URL itself when it will not parse. Never throws into a network call. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
