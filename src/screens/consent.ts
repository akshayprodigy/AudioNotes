/**
 * What the card held up to the room says.
 *
 * Text, so it can vary by region for nothing. The spoken announcement cannot and does not: it is
 * one bundled clip, and an audio asset per legal regime would be the jurisdiction map the design
 * rejected. The clip's sentence is safe everywhere because it states a fact and claims nothing.
 */

/**
 * Where the longer wording is used. Deliberately NOT a compliance map — nothing branches on this
 * except which paragraph is shown, and both paragraphs are true everywhere. A country missing from
 * this list gets a card that says less, never one that says something wrong.
 */
export const GDPR_REGIONS = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB', 'IS', 'LI', 'NO',
];

export type ConsentCardText = { title: string; body: string };

const PLAIN =
  'Audio is captured on this phone and stays on this phone. Nothing is uploaded. ' +
  'You can ask for it to be stopped or deleted at any time.';

const GDPR =
  'Audio is captured on this phone and stays on this phone. Nothing is uploaded. ' +
  'It is written up into notes on the device, and you can ask for it to be stopped or ' +
  'deleted at any time.';

/**
 * The card's words for a region code, or the plain wording when we do not recognise it.
 *
 * `region` comes from the SIM's network country, falling back to the device locale — both offline.
 * It is never asked for over the network and never derived from a location permission.
 */
export function consentCardText(region: string | null | undefined): ConsentCardText {
  const code = (region ?? '').trim().toUpperCase();
  return {
    title: 'This meeting is being recorded',
    body: GDPR_REGIONS.includes(code) ? GDPR : PLAIN,
  };
}
