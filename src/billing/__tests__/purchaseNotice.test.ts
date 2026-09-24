import { purchaseNotice } from '../purchaseNotice';

describe('purchaseNotice', () => {
  it('says a payment the server has not seen yet was received', () => {
    expect(purchaseNotice({ paid: false, pendingServer: true })?.title).toBe('Payment received');
  });
  it('says a slow payment is still processing', () => {
    expect(purchaseNotice({ paid: false, pendingPayment: true })?.title).toBe('Payment still processing');
  });
  it('says nothing for a success or a change of mind', () => {
    expect(purchaseNotice({ paid: true })).toBeNull();
    expect(purchaseNotice({ paid: false })).toBeNull();
  });
});
