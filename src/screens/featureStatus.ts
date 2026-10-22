/**
 * A feature's row in Settings says where it stands and offers nothing to press (founder, 22 Oct):
 * everything this phone is entitled to downloads by itself. Pure.
 */
export type FeatureRow = { installed: boolean; needsSubscription: boolean; unsupportedReason?: string | null };
export type FeatureStatus = 'ready' | 'unsupported' | 'downloading' | 'pro' | 'waiting';

export function featureStatus(m: FeatureRow, paid: boolean, downloading: boolean): FeatureStatus {
  if (m.installed) return 'ready';
  if (m.unsupportedReason) return 'unsupported';
  if (downloading) return 'downloading';
  if (m.needsSubscription && !paid) return 'pro';
  return 'waiting';
}

export const STATUS_LABEL: Record<FeatureStatus, string> = {
  ready: 'ON THIS PHONE',
  unsupported: 'NOT ON THIS PHONE',
  downloading: 'DOWNLOADING',
  pro: 'COMES WITH PRO',
  waiting: 'DOWNLOADS BY ITSELF',
};
