/**
 * What the "Ask this meeting" entry does, depending on who is asking and on what phone.
 *
 * Ask is Pro and it needs the writer, which a phone under the memory gate cannot run. So there are
 * four honest answers, never a button that opens a screen that then refuses: Pro on a capable
 * phone goes straight to Ask; a Free person is told what Ask is and offered Pro; and on a phone
 * that cannot run the writer the explanation says so, names what Pro DOES give there (the rows the
 * paywall promises without the writer), and does not promise Ask.
 */
export type AskState = 'open' | 'free' | 'free-weak' | 'pro-weak';

/**
 * `paid` null means not known yet. That opens Ask: the Ask screen's own native gate decides, and an
 * entry that waited on a check before it would open anything would feel broken.
 */
export function askState(i: { paid: boolean | null; writerBlocked: string | null }): AskState {
  if (i.paid === null) return 'open';
  if (i.writerBlocked) return i.paid ? 'pro-weak' : 'free-weak';
  return i.paid ? 'open' : 'free';
}

/**
 * The paywall rows that need no writer, by their titles there. The test reads PaywallScreen.tsx to
 * keep this list a subset of what the paywall itself promises on such a phone.
 */
export const PRO_WITHOUT_THE_WRITER = [
  'More meetings, any length',
  'Search by meaning',
  'Voices it remembers',
  'One thread across meetings',
  'Every action in one list',
] as const;

export type AskExplainer = {
  title: string;
  body: string;
  /** The label of the one Upgrade button, or null where there is nothing to buy. */
  upgrade: string | null;
};

const WHAT_ASK_DOES =
  'Ask answers a question about this meeting from its transcript, and shows the moment each ' +
  'answer came from. When nothing in the meeting settles it, it says so.';

export function askExplainer(state: AskState, writerBlocked: string | null): AskExplainer | null {
  switch (state) {
    case 'open':
      return null;
    case 'free':
      return {
        title: 'Ask this meeting',
        body: `${WHAT_ASK_DOES} It runs on your phone and is part of Pro. Everything else in this meeting stays free.`,
        upgrade: 'Upgrade to Pro',
      };
    case 'free-weak':
      return {
        title: 'Ask this meeting',
        body:
          `${WHAT_ASK_DOES} ${writerBlocked ?? ''} Ask cannot answer on this phone, so Pro would not ` +
          `add it here. What Pro does give this phone: ${PRO_WITHOUT_THE_WRITER.join('; ')}.`,
        upgrade: 'Upgrade to Pro',
      };
    case 'pro-weak':
      return {
        title: 'Ask this meeting',
        body: `${writerBlocked ?? ''} Ask cannot answer on this phone. Search by meaning still finds what was said.`,
        upgrade: null,
      };
  }
}
