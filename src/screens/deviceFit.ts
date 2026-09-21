/**
 * What ModelManager.list() says about THIS phone, read by every screen that offers the writer.
 *
 * `unsupportedReason` is composed natively (DeviceFit.kt): one sentence, the phone's memory in the
 * GB it was sold as, null for every model this phone can run. These helpers exist so no screen
 * re-derives "can the writer run here" from `kind` — which is how the writer came to be offered,
 * sold and downloaded on phones that could not run it. The meaning index shares the writer's
 * `kind` and runs anywhere; `runnable` keeps it and drops the writer alone.
 */
export type FitRow = { kind: string; unsupportedReason?: string | null };

/** The sentence to print instead of the writer's switch, button or promise — null when it runs here. */
export function writerBlockedReason(models: FitRow[]): string | null {
  const blocked = models.find(m => m.kind === 'llm' && m.unsupportedReason);
  return blocked?.unsupportedReason ?? null;
}

/** The part of a wanted set this phone can actually run: what a download plan may contain. */
export function runnable<T extends FitRow>(models: T[]): T[] {
  return models.filter(m => !m.unsupportedReason);
}

/** Megabytes, rounded, as the screens quote a download. */
export function sizeMb(models: { sizeBytes: number }[]): number {
  return Math.round(models.reduce((a, m) => a + m.sizeBytes, 0) / 1e6);
}

/** What ModelManager.deviceFit() returns: the phone itself, before any download. */
export type DeviceFit = { cpuReason: string | null; freeBytes: number };

/**
 * The disk rule and its sentence, mirrored from DeviceFit.kt so a screen can say it BEFORE the
 * tap (the native refusal says it again on the tap). Same headroom, same wording — the two tests
 * pin the same sentence in both languages.
 */
export const DOWNLOAD_HEADROOM_BYTES = 100 * 1024 * 1024;

export function spaceFits(needBytes: number, freeBytes: number): boolean {
  return freeBytes >= needBytes + DOWNLOAD_HEADROOM_BYTES;
}

export function spaceReason(what: string, needBytes: number, freeBytes: number): string {
  const mb = (b: number) => Math.round(b / 1e6);
  return `Downloading ${what} needs ${mb(needBytes + DOWNLOAD_HEADROOM_BYTES)} MB free; this phone has ${mb(freeBytes)} MB free. Clear some space and try again.`;
}
