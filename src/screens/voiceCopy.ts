/**
 * The Summary tab's voice banner (Phase 4). Names in speaker order; three or more collapse to
 * "and N more". Pure, so the wording is pinned by voiceCopy.test.ts and nowhere else.
 */
export function soundsLike(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `Sounds like ${names[0]} — confirm?`;
  if (names.length === 2) return `Sounds like ${names[0]} and ${names[1]} — confirm?`;
  const more = names.length - 2;
  return `Sounds like ${names[0]}, ${names[1]} and ${more} more — confirm?`;
}
