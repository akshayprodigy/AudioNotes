import { db } from '../db/queries';

/**
 * The share preview's "Created with Verbale" toggle, remembered.
 *
 * The `settings` key is also read NATIVELY (`FileExportModule.ATTRIBUTION_KEY`) by every way a
 * document leaves the app that has no preview in front of it — the Meeting screen's copy button
 * included — so the person's choice means one thing everywhere. Off unless they turned it on.
 */
export const ATTRIBUTION_KEY = 'shareAttribution';

export async function loadAttribution(): Promise<boolean> {
  try {
    return (await db.getSetting(ATTRIBUTION_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function saveAttribution(on: boolean): Promise<void> {
  try {
    await db.setSetting(ATTRIBUTION_KEY, on ? '1' : '0');
  } catch {
    // The toggle still applies to this share; only the memory of it is lost.
  }
}
