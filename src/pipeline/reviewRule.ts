/**
 * What the model could not settle — the mirror of ReviewRule.kt, against
 * cpp/tests/golden/review_rule.json. The phone decides `review` with the Kotlin one when it
 * classifies; the review card uses this one to say WHY an item is in front of the person.
 */
export type ReviewReason = 'type' | 'status' | 'owner' | 'date';

export interface ReviewInput {
  kind: string;
  type: string | null;
  status: string | null;
  confidence: string | null;
  ownerKind: string;
  dateSaid: string | null;
  dateNorm: number | null;
  currentReview: string;
}

export function decideReview(i: ReviewInput): { review: string; reason: ReviewReason | null } {
  if (i.currentReview === 'confirmed' || i.currentReview === 'rejected') return { review: i.currentReview, reason: null };
  if (i.currentReview === 'needs_review') return { review: i.currentReview, reason: null };
  const reason = reviewReason(i);
  return reason ? { review: 'needs_review', reason } : { review: 'suggested', reason: null };
}

/** The first trigger in priority order, ignoring the current review — what a card leads with. */
export function reviewReason(i: ReviewInput): ReviewReason | null {
  if (i.type === 'uncertain' || i.confidence === 'low') return 'type';
  if (i.status && i.status !== 'open') return 'status';
  if (i.kind === 'action' && i.ownerKind === 'unassigned') return 'owner';
  if (i.dateSaid && i.dateNorm === null) return 'date';
  return null;
}

export const REASON_TEXT: Record<ReviewReason, string> = {
  type: 'The model was not sure what this is.',
  status: 'A later turn pushed back on this.',
  owner: 'No owner.',
  date: 'The date could not be pinned to a day.',
};
