package com.innocorelabs.verbale

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.billing.LicenceStore
import com.innocorelabs.verbale.data.AudioDb
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * NOT a test of anything — a lever for a verification session on a phone with no Play product.
 *
 * Every Pro surface (narration, the classifier, the review queue, the meaning index, Ask) is
 * gated on LicenceStore.entitled, and on a phone that cannot buy the subscription the only key
 * is the seven-day, three-summary trial, which a previous session has usually spent. This starts
 * a fresh one and leaves it started — deliberately not restored, unlike NativePipelineTest's
 * grantTrial — so a person driving the app by hand afterwards is on Pro.
 *
 * Runs only when asked for by name (`scripts/device-verify.sh VerificationTrial`); it is not in
 * the script's CLASSES list, so a normal run never touches the phone's trial.
 */
@RunWith(AndroidJUnit4::class)
class VerificationTrialTest {
  @Test fun startAFreshTrialForThisVerificationSession() {
    val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    val db = AudioDb.get(ctx)
    db.putSetting("trial_started_at", LicenceStore.now(ctx).toString())
    db.putSetting("trial_summaries_used", "0")
    db.putSetting("trial_ended_at", "0")
    assertTrue("the trial did not take", LicenceStore.entitled(ctx))
    println("VERIFICATION: trial started; the phone is on Pro for 7 days / 3 summaries")
  }
}
