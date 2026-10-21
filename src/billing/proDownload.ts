import { runnable } from '../screens/deviceFit';

/** A ModelManager.list() row, as much of it as the plan reads. */
export type ProRow = {
  id: string;
  kind: string;
  sizeBytes: number;
  installed: boolean;
  needsSubscription: boolean;
  unsupportedReason?: string | null;
};

/**
 * What a subscription still has to put on THIS phone: every model the catalog puts behind Pro
 * (`needsSubscription`, decided natively in ModelCatalog), not yet installed, that this phone can
 * run. Smallest first, so the first improvement arrives in seconds rather than after the 1.1 GB
 * writer. Pure.
 */
export function proToFetch<T extends ProRow>(all: T[]): T[] {
  return runnable(all.filter(m => m.needsSubscription && !m.installed)).sort((a, b) => a.sizeBytes - b.sizeBytes);
}
