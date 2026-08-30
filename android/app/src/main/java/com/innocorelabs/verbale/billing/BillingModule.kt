package com.innocorelabs.verbale.billing

import android.util.Log
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.innocorelabs.verbale.BuildConfig

/**
 * Google Play Billing.
 *
 * This module buys things. It does **not** decide what anybody is entitled to.
 *
 * That separation is the whole design. A purchase here produces one thing — a purchase token — and
 * that token is a claim, not a proof. It goes to the licence server, which asks Google whether it
 * is real and mints a signed licence if it is. Nothing in this file, and nothing in the JavaScript
 * that calls it, can grant Pro: Narrator.run and ModelManagerModule.download check a signature they
 * cannot forge. Somebody who patches this class gets a token the server will reject.
 *
 * ## What is deliberately not here
 *
 * **Acknowledgement.** Google auto-refunds a purchase not acknowledged within three days, and it is
 * tempting to do it here, immediately, where the purchase happened. But the app can be killed, lose
 * its network or be uninstalled between paying and acknowledging, and the customer then gets a
 * silent refund and a subscription that stops working. The server acknowledges after it has
 * recorded entitlement, which is the only ordering that cannot strand somebody who has paid.
 * acknowledgeLocally below is the fallback for when the server could not be reached at all.
 *
 * **Price formatting.** formattedPrice arrives from Google already localised to the buyer's country
 * and currency. Reformatting it is how an app ends up showing rupees to somebody being charged in
 * dollars.
 */
class BillingModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "Billing"

  private val productId: String = BuildConfig.PLAY_SUBSCRIPTION_ID

  /** Set for the duration of one purchase flow; resolved by the listener Google calls back on. */
  @Volatile private var pending: Promise? = null

  @Volatile private var client: BillingClient? = null

  private val purchasesUpdated = PurchasesUpdatedListener { result, purchases ->
    val promise = pending ?: return@PurchasesUpdatedListener
    pending = null
    when (result.responseCode) {
      BillingClient.BillingResponseCode.OK -> {
        val token = purchases?.firstOrNull { it.products.contains(productId) }?.purchaseToken
        // OK with nothing to show for it means the purchase is still pending — some UPI mandates
        // authorise minutes later. Not a failure: the server will say "not paid yet" and a later
        // restore picks it up.
        promise.resolve(if (token.isNullOrEmpty()) null else token)
      }
      // Backing out is a choice, not an error. Rejecting would put an alarming dialog in front of
      // somebody who simply changed their mind.
      BillingClient.BillingResponseCode.USER_CANCELED -> promise.resolve(null)
      else -> promise.reject("billing_failed", describe(result))
    }
  }

  private fun describe(result: BillingResult): String =
    "${result.debugMessage.ifBlank { "Play Billing error" }} (code ${result.responseCode})"

  /**
   * Get a connected client, or fail.
   *
   * Reconnects rather than reusing a dead one: Play services restarts, and a client whose service
   * has disconnected fails every subsequent call with no way back.
   */
  private fun withClient(onError: (String) -> Unit, block: (BillingClient) -> Unit) {
    val existing = client
    if (existing != null && existing.isReady) {
      block(existing)
      return
    }
    val fresh = BillingClient.newBuilder(ctx)
      .setListener(purchasesUpdated)
      .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
      .build()
    client = fresh
    fresh.startConnection(object : BillingClientStateListener {
      override fun onBillingSetupFinished(result: BillingResult) {
        if (result.responseCode == BillingClient.BillingResponseCode.OK) {
          block(fresh)
        } else {
          onError(describe(result))
        }
      }

      override fun onBillingServiceDisconnected() {
        // Dropped, so the next call builds a new one rather than reusing a corpse.
        client = null
      }
    })
  }

  /**
   * Whether buying is possible on this install at all.
   *
   * False on a device with no Play Store, and on a build side-loaded or installed from another
   * store — Play Billing only works for Play installs. The UI uses this to decide between offering
   * a purchase button and pointing at the website.
   */
  @ReactMethod
  fun available(promise: Promise) {
    withClient({ promise.resolve(false) }) { billing ->
      promise.resolve(
        billing.isFeatureSupported(BillingClient.FeatureType.SUBSCRIPTIONS).responseCode ==
          BillingClient.BillingResponseCode.OK,
      )
    }
  }

  private fun productDetails(onError: (String) -> Unit, block: (ProductDetails) -> Unit) {
    withClient(onError) { billing ->
      val params = QueryProductDetailsParams.newBuilder()
        .setProductList(
          listOf(
            QueryProductDetailsParams.Product.newBuilder()
              .setProductId(productId)
              .setProductType(BillingClient.ProductType.SUBS)
              .build(),
          ),
        )
        .build()
      billing.queryProductDetailsAsync(params) { result, details ->
        val found = details.firstOrNull()
        if (result.responseCode != BillingClient.BillingResponseCode.OK || found == null) {
          // Almost always the product id here and the one in Play Console disagreeing, or a build
          // Play does not recognise. Said plainly, because the symptom on the phone is a blank
          // price with nothing to suggest why.
          onError(
            "No subscription '$productId' is available. Check that the product id matches Play " +
              "Console and that this build was installed from Play.",
          )
        } else {
          block(found)
        }
      }
    }
  }

  /** The subscription's price, already localised by Google. Null when it cannot be read. */
  @ReactMethod
  fun price(promise: Promise) {
    productDetails({ promise.resolve(null) }) { details ->
      val phase = details.subscriptionOfferDetails
        ?.firstOrNull()
        ?.pricingPhases
        ?.pricingPhaseList
        ?.firstOrNull()
      promise.resolve(
        Arguments.createMap().apply {
          putString("price", phase?.formattedPrice)
          putString("period", phase?.billingPeriod)
          putString("title", details.title)
        },
      )
    }
  }

  /**
   * Launch the purchase flow. Resolves with a purchase token, or null if the user backed out.
   *
   * The token is worth nothing by itself. Hand it to the licence server, which is the only thing
   * that can turn it into entitlement.
   */
  @ReactMethod
  fun purchase(promise: Promise) {
    val activity = ctx.currentActivity
    if (activity == null) {
      promise.reject("no_activity", "The app is not in the foreground.")
      return
    }
    productDetails({ promise.reject("billing_unavailable", it) }) { details ->
      val offerToken = details.subscriptionOfferDetails?.firstOrNull()?.offerToken
      if (offerToken == null) {
        promise.reject("no_offer", "That subscription has no offer configured in Play Console.")
        return@productDetails
      }
      val flow = BillingFlowParams.newBuilder()
        .setProductDetailsParamsList(
          listOf(
            BillingFlowParams.ProductDetailsParams.newBuilder()
              .setProductDetails(details)
              .setOfferToken(offerToken)
              .build(),
          ),
        )
        .build()
      pending = promise
      withClient({
        pending = null
        promise.reject("billing_unavailable", it)
      }) { billing ->
        val result = billing.launchBillingFlow(activity, flow)
        if (result.responseCode != BillingClient.BillingResponseCode.OK) {
          pending = null
          promise.reject("billing_failed", describe(result))
        }
        // Otherwise the answer arrives on purchasesUpdated, which resolves the promise.
      }
    }
  }

  /**
   * Find a subscription this Google account already owns.
   *
   * This is "restore purchases", and it is also what runs on a new device and after a reinstall.
   * Play knows what was bought; the licence server turns that back into a licence for this device.
   */
  @ReactMethod
  fun restore(promise: Promise) {
    withClient({ promise.reject("billing_unavailable", it) }) { billing ->
      val params = QueryPurchasesParams.newBuilder()
        .setProductType(BillingClient.ProductType.SUBS)
        .build()
      billing.queryPurchasesAsync(params) { result, purchases ->
        if (result.responseCode != BillingClient.BillingResponseCode.OK) {
          promise.reject("billing_failed", describe(result))
          return@queryPurchasesAsync
        }
        val owned = purchases.firstOrNull {
          it.products.contains(productId) && it.purchaseState == Purchase.PurchaseState.PURCHASED
        }
        promise.resolve(owned?.purchaseToken)
      }
    }
  }

  /**
   * Acknowledge a purchase from the device, as a fallback.
   *
   * The server does this, and doing it there is right — but only if the server was reachable.
   * Somebody who buys on a bad connection and never opens the app again would otherwise be refunded
   * by Google after three days and lose a subscription they wanted. Called only when the server
   * could not be reached; acknowledging twice is harmless.
   */
  @ReactMethod
  fun acknowledgeLocally(purchaseToken: String, promise: Promise) {
    withClient({ promise.resolve(false) }) { billing ->
      val params = AcknowledgePurchaseParams.newBuilder()
        .setPurchaseToken(purchaseToken)
        .build()
      billing.acknowledgePurchase(params) { result ->
        if (result.responseCode != BillingClient.BillingResponseCode.OK) {
          Log.w("Billing", "local acknowledge failed: ${describe(result)}")
        }
        promise.resolve(result.responseCode == BillingClient.BillingResponseCode.OK)
      }
    }
  }

  override fun invalidate() {
    client?.endConnection()
    client = null
    super.invalidate()
  }
}
