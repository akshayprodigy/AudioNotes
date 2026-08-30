/**
 * The Play purchase path, from the JS side.
 *
 * The interesting cases are all failures. A successful purchase is one happy call; what matters is
 * what happens when the buyer changes their mind, when the payment is still authorising, and when
 * the purchase succeeds but the server cannot be told about it.
 */
import { buyWithPlay, playAvailable, playPrice, restorePlayPurchase } from '../subscription';

// The stubs jest.setup.js registered with TurboModuleRegistry. Reached through the escape hatch it
// exposes, rather than NativeModules, because the specs use TurboModuleRegistry.getEnforcing and
// the two registries are not the same object.
const { Billing, Licence } = (global as unknown as {
  __TEST_NATIVE_MODULES__: Record<string, Record<string, jest.Mock>>;
}).__TEST_NATIVE_MODULES__;

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) } as Response);

beforeEach(() => {
  jest.clearAllMocks();
  Licence.baseUrl.mockResolvedValue('https://verbale.example.com');
  Licence.deviceId.mockResolvedValue('device-1');
  Licence.store.mockResolvedValue(true);
  global.fetch = jest.fn();
});

describe('buying', () => {
  it('sends the purchase token to the server and stores what comes back', async () => {
    Billing.purchase.mockResolvedValue('token-abc');
    (global.fetch as jest.Mock).mockReturnValue(
      ok({ token: 'licence-xyz', refreshKey: 'refresh-1', plan: 'pro' }),
    );

    await expect(buyWithPlay()).resolves.toEqual({ paid: true });

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://verbale.example.com/api/billing/play/link');
    expect(JSON.parse(init.body)).toEqual({
      purchaseToken: 'token-abc',
      deviceId: 'device-1',
    });
    expect(Licence.store).toHaveBeenCalledWith('licence-xyz', 'refresh-1');
  });

  it('treats backing out as a decision, not a failure', async () => {
    Billing.purchase.mockResolvedValue(null);
    await expect(buyWithPlay()).resolves.toEqual({ paid: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not grant Pro when the server issues no licence', async () => {
    // A payment still authorising — some UPI mandates settle minutes later. The account exists,
    // it is simply not paid yet.
    Billing.purchase.mockResolvedValue('token-abc');
    (global.fetch as jest.Mock).mockReturnValue(
      ok({ token: null, refreshKey: 'refresh-1', plan: 'free' }),
    );
    await expect(buyWithPlay()).resolves.toEqual({ paid: false });
  });

  it('acknowledges the purchase locally when the server cannot be reached', async () => {
    // Google refunds anything unacknowledged after three days. Without this, somebody who buys on
    // a bad connection and never reopens the app loses the subscription they wanted, silently.
    Billing.purchase.mockResolvedValue('token-abc');
    (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));

    await expect(buyWithPlay()).rejects.toThrow('offline');
    expect(Billing.acknowledgeLocally).toHaveBeenCalledWith('token-abc');
  });

  it('does not acknowledge anything when there was no purchase to acknowledge', async () => {
    Billing.purchase.mockResolvedValue(null);
    await buyWithPlay();
    expect(Billing.acknowledgeLocally).not.toHaveBeenCalled();
  });

  it('refuses when the build has no licence server', async () => {
    Licence.baseUrl.mockResolvedValue('');
    await expect(buyWithPlay()).rejects.toThrow('no licence server');
    expect(Billing.purchase).not.toHaveBeenCalled();
  });
});

describe('restoring', () => {
  it('exchanges an owned purchase for a licence', async () => {
    Billing.restore.mockResolvedValue('token-owned');
    (global.fetch as jest.Mock).mockReturnValue(
      ok({ token: 'licence-xyz', refreshKey: 'refresh-1', plan: 'pro' }),
    );
    await expect(restorePlayPurchase()).resolves.toEqual({ paid: true });
  });

  it('is a no-op when this Google account owns nothing', async () => {
    // Called on every open, so the common case must cost one native call and no network.
    Billing.restore.mockResolvedValue(null);
    await expect(restorePlayPurchase()).resolves.toEqual({ paid: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('survives Play Billing being unavailable', async () => {
    Billing.restore.mockRejectedValue(new Error('no Play Store'));
    await expect(restorePlayPurchase()).resolves.toEqual({ paid: false });
  });
});

describe('capability checks fail closed', () => {
  it('reports unavailable rather than throwing', async () => {
    Billing.available.mockRejectedValue(new Error('no Play Store'));
    await expect(playAvailable()).resolves.toBe(false);
  });

  it('reports no price rather than throwing', async () => {
    Billing.price.mockRejectedValue(new Error('product not found'));
    await expect(playPrice()).resolves.toBeNull();
  });

  it('reports no price when Play returns nothing useful', async () => {
    Billing.price.mockResolvedValue(null);
    await expect(playPrice()).resolves.toBeNull();
  });
});
