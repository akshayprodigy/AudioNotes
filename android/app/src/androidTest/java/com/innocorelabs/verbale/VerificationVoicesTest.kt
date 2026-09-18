package com.innocorelabs.verbale

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.billing.LicenceStore
import com.innocorelabs.verbale.data.AudioDb
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * NOT tests — two levers for a by-hand verification of remembered voices (Phase 4), run by name:
 *
 *   adb shell am instrument -w -r -e class com.innocorelabs.verbale.VerificationVoicesTest#resetTheVoicePrompt \
 *     com.innocorelabs.verbale.test/androidx.test.runner.AndroidJUnitRunner
 *
 * `resetTheVoicePrompt` forgets that the one-time "Remember this voice?" card was ever shown and
 * that the setting was ever set, so the card can be seen again on the next rename without a fresh
 * install. `endTheTrial` writes the trial off so the free-tier shape of the screens can be seen;
 * `VerificationTrialTest` starts it again. Not in device-verify's CLASSES.
 */
@RunWith(AndroidJUnit4::class)
class VerificationVoicesTest {
  @Test fun resetTheVoicePrompt() {
    val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    val db = AudioDb.get(ctx)
    db.exec("DELETE FROM settings WHERE key IN ('voices_prompted','voices_remember')")
    assertNull(db.getSetting("voices_prompted"))
    assertNull(db.getSetting("voices_remember"))
    println("VERIFICATION: voice prompt reset; the next rename of a named speaker shows the card")
  }

  @Test fun endTheTrial() {
    val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    val db = AudioDb.get(ctx)
    db.putSetting("trial_ended_at", LicenceStore.now(ctx).toString())
    assertFalse("still entitled — a licence token is present; sign out first", LicenceStore.entitled(ctx))
    println("VERIFICATION: trial ended; the phone is on Free until VerificationTrialTest runs")
  }
}
