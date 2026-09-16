import { dayLabel } from '../../pipeline/dateNorm';

/** The part of the typed record a row wears: nothing at all until the classifier has read it. */
export interface RecordSummary {
  itemType: string | null;
  status: string | null;
  dateNorm: number | null;
}

export interface Labels {
  type?: string;
  status?: string;
  day?: string;
}

const TYPE_LABEL: Record<string, string> = {
  proposal: 'Proposal',
  agreement: 'Agreement',
  commitment: 'Commitment',
  request: 'Request',
  rejection: 'Rejection',
  unresolved: 'Unresolved',
  uncertain: 'Not sure',
};

const STATUS_LABEL: Record<string, string> = {
  qualified: 'Qualified',
  contradicted: 'Contradicted',
  withdrawn: 'Withdrawn',
};

/**
 * "Open" is not a label — it is the absence of one. The day is shown in UTC on purpose: the
 * phone stores a local midnight, and rendering it in the phone's zone would show the day before
 * for anyone west of the meeting.
 */
export function labelsFor(r: RecordSummary | null): Labels {
  if (!r || !r.itemType) return {};
  const out: Labels = { type: TYPE_LABEL[r.itemType] ?? r.itemType };
  if (r.status && STATUS_LABEL[r.status]) out.status = STATUS_LABEL[r.status];
  if (r.dateNorm !== null && r.dateNorm !== undefined) out.day = dayLabel(r.dateNorm);
  return out;
}
