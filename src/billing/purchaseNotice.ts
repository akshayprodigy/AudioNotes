import type { PlayResult } from './subscription';

/**
 * What to tell a buyer whose purchase did not end in "You are on Pro" but did not fail either.
 * Pure, so every screen that buys says the same thing and tests need no mocks.
 */
export interface Notice {
  title: string;
  body: string;
}

export function purchaseNotice(r: PlayResult): Notice | null {
  if (r.pendingServer) {
    return {
      title: 'Payment received',
      body:
        'Google Play has your payment. Verbale could not reach its server just now, so Pro will ' +
        'switch on by itself the next time the app is open with a connection. You will not be ' +
        'charged twice.',
    };
  }
  if (r.pendingPayment) {
    return {
      title: 'Payment still processing',
      body:
        'Google Play is still confirming the payment. Pro switches on by itself once it goes ' +
        'through — usually within a few minutes. There is nothing more to do.',
    };
  }
  return null;
}
