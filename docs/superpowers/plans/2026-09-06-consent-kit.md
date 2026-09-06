# The Consent Kit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the room the meeting is being recorded, in a way the recording itself can prove afterwards.

**Architecture:** A bundled clip in `res/raw` is played through the speaker immediately after `AudioRecord` goes live, so the microphone captures it and the disclosure becomes the first line of the transcript. A new `AnnouncementPlayer` owns playback and reports whether it actually finished; only a confirmed finish stamps `meetings.announced_at`. A separate full-screen card shows the same disclosure as text, worded by an offline region check that never touches the network.

**Tech Stack:** Kotlin (Android service + `MediaPlayer`), SQLCipher, TypeScript/React Native 0.86.

**Spec:** `docs/superpowers/specs/2026-09-05-consent-kit-design.md`

---

## Build and test commands

`cmake` and `adb` are not on PATH on this machine.

```bash
export ANDROID_HOME=/Users/akshayghosh/Android/Library/SDK
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home
export PATH=$ANDROID_HOME/platform-tools:$PATH

cd android && ./gradlew :app:testDebugUnitTest          # Kotlin unit tests
cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a \
  -PAUDIONOTES_DEBUG_UPLOAD_SIGNING                      # app builds
npm test && npx tsc --noEmit && npm run lint             # TypeScript

# On-device — NEVER `./gradlew connectedDebugAndroidTest`; it uninstalls the app and wipes
# the models and the recordings database.
npm run test:device
```

**Lint baseline:** the repo has ~467 pre-existing eslint errors. Compare against `main` for the
files you touched rather than expecting zero.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `android/.../pipeline/AnnouncementPlayer.kt` | Play the clip; say whether it finished | Create |
| `android/app/src/main/res/raw/consent_announcement.wav` | The spoken disclosure | Create (placeholder, then replaced) |
| `android/.../pipeline/RecordingService.kt` | Fire the announcement once capture is live | Modify |
| `android/.../data/AudioDb.kt` | `announced_at` column + accessors | Modify |
| `android/app/src/test/.../AnnouncementTest.kt` | Playback outcome → stamping | Create |
| `src/screens/consent.ts` | Region → card wording (pure) | Create |
| `src/screens/__tests__/consent.test.ts` | That mapping | Create |
| `src/screens/ConsentCardScreen.tsx` | The card to show the room | Create |
| `src/navigation/RootNavigator.tsx` | Register the card | Modify |
| `src/screens/RecordScreen.tsx` | Route to the card | Modify |
| `src/screens/SettingsScreen.tsx` | The announcement toggle | Modify |
| `src/db/schema.ts` | Readable schema copy | Modify |
| `docs/NEXT.md` | Record what shipped and what is outstanding | Modify |

---

## Task 1: The announcement outcome, and what it is allowed to claim

The core rule of the whole feature: a meeting is marked announced **only** when playback actually
finished. Built first, and in isolation, because everything else depends on it being right.

**Files:**
- Create: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/AnnouncementPlayer.kt`
- Test: `android/app/src/test/java/com/innocorelabs/verbale/pipeline/AnnouncementTest.kt`

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/java/com/innocorelabs/verbale/pipeline/AnnouncementTest.kt`:

```kotlin
package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the app is allowed to claim about the announcement.
 *
 * The feature exists to let a recording prove the room was told. An app that reported "told"
 * because it TRIED to tell them would be worse than one with no announcement at all: the person
 * would stop checking, which is the one behaviour this is supposed to produce.
 */
class AnnouncementTest {

  @Test
  fun a_finished_announcement_counts() {
    assertTrue(AnnouncementPlayer.Outcome.PLAYED.wasHeard())
  }

  @Test
  fun a_silenced_or_failed_announcement_does_not_count() {
    assertFalse(AnnouncementPlayer.Outcome.FAILED.wasHeard())
    assertFalse(AnnouncementPlayer.Outcome.NO_CLIP.wasHeard())
    assertFalse(AnnouncementPlayer.Outcome.SILENCED.wasHeard())
  }

  @Test
  fun switched_off_is_not_a_failure_and_still_does_not_count() {
    // Somebody who turned it off and announced it themselves has not failed at anything. The
    // meeting still carries no evidence, so it must not be stamped either.
    assertFalse(AnnouncementPlayer.Outcome.DISABLED.wasHeard())
  }

  @Test
  fun every_outcome_has_a_reason_a_person_could_act_on() {
    // A failure the user cannot interpret is a failure they will ignore. SILENCED and NO_CLIP
    // have different remedies, so they must not collapse into one message.
    val messages = AnnouncementPlayer.Outcome.values()
      .filter { !it.wasHeard() && it != AnnouncementPlayer.Outcome.DISABLED }
      .map { it.userMessage() }
    assertTrue("each failure needs its own wording", messages.toSet().size == messages.size)
    assertTrue("no failure may be silent", messages.none { it.isBlank() })
  }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests '*AnnouncementTest*' 2>&1 | grep -A4 'What went wrong'
```

Expected: `Compilation error` — `AnnouncementPlayer` does not exist.

- [ ] **Step 3: Write the implementation**

Create `android/app/src/main/java/com/innocorelabs/verbale/pipeline/AnnouncementPlayer.kt`:

```kotlin
package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.util.Log
import com.innocorelabs.verbale.R

/**
 * Speaks the recording disclosure into the room, while the microphone is already live.
 *
 * The point is not the sound. It is that capture has started, so the clip lands in the audio and
 * becomes the first line of the transcript — the recording carries its own proof that the room was
 * told, and that proof travels with the exported file. A consent flag in a local database proves
 * nothing to anybody off the phone.
 *
 * A bundled clip rather than TextToSpeech, which was the obvious first answer. Google's TTS
 * synthesises over the NETWORK for its better voices, and the next thing on the roadmap is a
 * screen reading "Network calls this month: 1 licence check". A consent feature cannot be the
 * thing that falsifies the privacy claim. A bundled file is also deterministic, verifiable, and
 * has no engine to be missing.
 */
object AnnouncementPlayer {

  private const val TAG = "AnnouncementPlayer"

  /** Whether the room actually heard it, and if not, what to tell the person holding the phone. */
  enum class Outcome {
    /** Played to completion while the microphone was live. The only outcome that is evidence. */
    PLAYED,
    /** The user turned it off. Not a failure; simply no evidence. */
    DISABLED,
    /** The device is muted or in Do Not Disturb, so nobody heard it. */
    SILENCED,
    /** No clip is bundled in this build. */
    NO_CLIP,
    /** Playback started and did not finish: audio focus lost, decoder error, speaker fault. */
    FAILED;

    /** True only when the room was actually told. Nothing else may stamp a meeting. */
    fun wasHeard(): Boolean = this == PLAYED

    /** What to show the person holding the phone. Empty for the outcomes that need no message. */
    fun userMessage(): String = when (this) {
      PLAYED, DISABLED -> ""
      SILENCED -> "Your phone is on silent, so the announcement was not heard. Tell the room yourself."
      NO_CLIP -> "The announcement is unavailable in this build. Tell the room yourself."
      FAILED -> "The announcement did not finish playing. Tell the room yourself."
    }
  }

  /**
   * Play the clip and block until it finishes or fails.
   *
   * Synchronous on purpose: the caller is the capture thread's setup path, and the outcome decides
   * whether the meeting may be stamped. An async version would have to invent a rule for what to
   * claim before the answer arrived, and the only safe rule is to claim nothing.
   */
  fun announce(ctx: Context, enabled: Boolean): Outcome {
    if (!enabled) return Outcome.DISABLED

    val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    if (audio != null && audio.getStreamVolume(AudioManager.STREAM_MUSIC) == 0) {
      return Outcome.SILENCED
    }

    var player: MediaPlayer? = null
    return try {
      player = MediaPlayer.create(ctx, R.raw.consent_announcement)
        ?: return Outcome.NO_CLIP
      player.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build(),
      )
      val done = java.util.concurrent.CountDownLatch(1)
      var ok = false
      player.setOnCompletionListener { ok = true; done.countDown() }
      player.setOnErrorListener { _, what, extra ->
        Log.w(TAG, "announcement error what=$what extra=$extra")
        done.countDown()
        true
      }
      player.start()
      // Bounded so a wedged decoder cannot hold the capture thread open forever. The clip is a
      // single sentence; ten seconds is far past any honest playback.
      val finished = done.await(10, java.util.concurrent.TimeUnit.SECONDS)
      if (finished && ok) Outcome.PLAYED else Outcome.FAILED
    } catch (e: Exception) {
      Log.w(TAG, "announcement failed", e)
      Outcome.FAILED
    } finally {
      try {
        player?.release()
      } catch (e: Exception) {
        Log.w(TAG, "player release failed", e)
      }
    }
  }
}
```

- [ ] **Step 4: Create the development placeholder clip**

The shipping clip must be recorded by a person — a synthesised voice is an odd thing to open a
trust-first product with, and the spec says so. But the build needs `R.raw.consent_announcement` to
exist, so generate a clearly-temporary one now and replace it in Task 8.

```bash
mkdir -p android/app/src/main/res/raw
say -v Daniel -o /tmp/consent.aiff \
  "This meeting is being recorded by Verbale. The recording stays on this phone."
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/consent.aiff \
  android/app/src/main/res/raw/consent_announcement.wav
ls -l android/app/src/main/res/raw/consent_announcement.wav
```

Expected: a mono 16 kHz WAV, roughly 100–200 KB.

- [ ] **Step 5: Run the tests**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests '*AnnouncementTest*' 2>&1 | grep -E 'BUILD|FAILED'
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/pipeline/AnnouncementPlayer.kt \
        android/app/src/test/java/com/innocorelabs/verbale/pipeline/AnnouncementTest.kt \
        android/app/src/main/res/raw/consent_announcement.wav
git commit -m "feat(consent): say the disclosure out loud, and only claim it when it was heard

A bundled clip rather than TTS: Google's TTS synthesises over the network for its better voices,
and the next roadmap item is a screen claiming one network call a month.

The clip checked in here is a synthesised PLACEHOLDER so the build resolves R.raw. It must be
replaced with a human recording before launch."
```

---

## Task 2: Remember whether a meeting was announced

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt`
- Modify: `src/db/schema.ts`
- Test: `android/app/src/test/java/com/innocorelabs/verbale/pipeline/AnnouncementTest.kt`

- [ ] **Step 1: Write the failing test**

Append inside the `AnnouncementTest` class:

```kotlin
  @Test
  fun the_announced_column_is_declared_in_the_migration_list() {
    val added = com.innocorelabs.verbale.data.AudioDb.addedColumnsForTest()
    org.junit.Assert.assertEquals(
      "INTEGER",
      added.firstOrNull { it.first == "meetings" && it.second == "announced_at" }?.third,
    )
  }
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests '*AnnouncementTest*' 2>&1 | grep -E 'announced_at|FAILED|expected'
```

Expected: an assertion failure — `expected:<INTEGER> but was:<null>`.

- [ ] **Step 3: Add the column and its accessors**

In `AudioDb.kt`, inside `ADDED_COLUMNS`, after the `forced_from_language` entry:

```kotlin
      // The moment the spoken disclosure finished playing while the microphone was live. Set only
      // on confirmed completion — a meeting where playback was silenced or failed carries no
      // stamp, because the room did not hear it and the recording is not evidence of anything.
      Triple("meetings", "announced_at", "INTEGER"),
```

In the same file, next to `transcribeForcedAt`:

```kotlin
  /** Stamp the moment the room was told. Only ever called for Outcome.PLAYED. */
  fun markAnnounced(id: String, atMs: Long) {
    db.execSQL("UPDATE meetings SET announced_at=? WHERE id=?", arrayOf<Any?>(atMs, id))
  }

  /** Null when this meeting carries no announcement. */
  fun announcedAt(id: String): Long? {
    db.rawQuery("SELECT announced_at FROM meetings WHERE id=?", arrayOf(id)).use { c ->
      if (!c.moveToFirst() || c.isNull(0)) return null
      return c.getLong(0)
    }
  }
```

- [ ] **Step 4: Mirror it in the readable schema**

In `src/db/schema.ts`, change:

```
     forced_from_language TEXT     -- what was heard before they did; the banner's claim
```

to:

```
     forced_from_language TEXT,    -- what was heard before they did; the banner's claim
     announced_at INTEGER          -- when the spoken disclosure finished, while the mic was live
```

- [ ] **Step 5: Run the tests**

```bash
cd android && ./gradlew :app:testDebugUnitTest 2>&1 | grep -E 'BUILD|FAILED'
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt \
        android/app/src/test/java/com/innocorelabs/verbale/pipeline/AnnouncementTest.kt \
        src/db/schema.ts
git commit -m "feat(db): remember when the room was actually told"
```

---

## Task 3: Fire it once capture is live

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/RecordingService.kt`

- [ ] **Step 1: Note why the audio source matters**

In `RecordingService.kt`, find:

```kotlin
    val source =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) MediaRecorder.AudioSource.UNPROCESSED
      else MediaRecorder.AudioSource.VOICE_RECOGNITION
```

Add directly above it:

```kotlin
    // UNPROCESSED and VOICE_RECOGNITION were chosen for ASR quality, and a second feature now
    // depends on them: neither applies the acoustic echo cancellation that VOICE_COMMUNICATION
    // does, which is the only reason the spoken consent announcement below is captured by this
    // microphone instead of being filtered back out. Change this source and the consent kit
    // silently stops producing evidence while continuing to look like it works.
```

- [ ] **Step 2: Announce, after capture has started**

Find, in `startCapture`:

```kotlin
    recording = true
    audioRecord = record
    registerAudioWatchers(record)
```

Add directly below it:

```kotlin
    // AFTER the recorder is live, deliberately: the clip has to land IN the audio. Announcing
    // first would produce a polite app and a recording that proves nothing.
    //
    // On the capture thread's setup path rather than a background one, because the outcome decides
    // whether the meeting may be stamped, and there is no safe thing to claim while the answer is
    // still outstanding.
    thread(name = "audionotes-announce") {
      val db = AudioDb.get(applicationContext)
      val enabled = db.getSetting("announceRecording") != "0"
      val outcome = AnnouncementPlayer.announce(applicationContext, enabled)
      if (outcome.wasHeard()) {
        meetingId?.let { db.markAnnounced(it, System.currentTimeMillis()) }
      } else if (outcome != AnnouncementPlayer.Outcome.DISABLED) {
        Log.w(TAG, "announcement not heard: $outcome")
      }
    }
```

`meetingId` is the service's own field (`private var meetingId: String?`, set in `onStartCommand`)
— the same one `markCaptured` reads when capture ends.

- [ ] **Step 3: Build**

```bash
export ANDROID_HOME=/Users/akshayghosh/Android/Library/SDK
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home
cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a \
  -PAUDIONOTES_DEBUG_UPLOAD_SIGNING 2>&1 | grep -E 'BUILD|error'
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/pipeline/RecordingService.kt
git commit -m "feat(consent): announce into the live microphone, not before it

The clip has to land IN the audio. Announcing first would produce a polite app and a recording
that proves nothing."
```

---

## Task 4: The card's wording, by region

**Files:**
- Create: `src/screens/consent.ts`
- Test: `src/screens/__tests__/consent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/screens/__tests__/consent.test.ts`:

```ts
import { consentCardText, GDPR_REGIONS } from '../consent';

/**
 * The card is text, so it can vary by region at no cost. The SPOKEN clip cannot — it is one
 * bundled file, and shipping an audio asset per legal regime would be the jurisdiction map the
 * spec rejected, wearing a different hat.
 */
describe('the card the room is shown', () => {
  it('names the recording and its purpose in GDPR territories', () => {
    const t = consentCardText('DE');
    expect(t.title).toBe('This meeting is being recorded');
    expect(t.body).toContain('stays on this phone');
    expect(t.body).toContain('written up into notes');
  });

  it('uses plain disclosure everywhere else', () => {
    const t = consentCardText('US');
    expect(t.title).toBe('This meeting is being recorded');
    expect(t.body).toContain('stays on this phone');
    expect(t.body).not.toContain('written up into notes');
  });

  it('falls back to the plain wording for a region it does not know', () => {
    // Says less, not more, which is safe in every jurisdiction.
    expect(consentCardText(null).body).toBe(consentCardText('US').body);
    expect(consentCardText('ZZ').body).toBe(consentCardText('US').body);
    expect(consentCardText('').body).toBe(consentCardText('US').body);
  });

  it('is case-insensitive about the region code', () => {
    expect(consentCardText('de').body).toBe(consentCardText('DE').body);
  });

  it('never tells anybody they are compliant', () => {
    // The app reports what it did, never what that means legally. A confident wrong jurisdiction
    // call is worse than none, and this ships into dozens of legal regimes.
    for (const region of [...GDPR_REGIONS, 'US', 'IN', null]) {
      const t = consentCardText(region);
      const all = `${t.title} ${t.body}`.toLowerCase();
      expect(all).not.toContain('legal');
      expect(all).not.toContain('complian');
      expect(all).not.toContain('consent is required');
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- consent 2>&1 | tail -8
```

Expected: `Cannot find module '../consent'`.

- [ ] **Step 3: Write the implementation**

Create `src/screens/consent.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- consent 2>&1 | tail -6
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/screens/consent.ts src/screens/__tests__/consent.test.ts
git commit -m "feat(consent): the card's wording, and the line it never crosses

Reports what the app did, never that anybody is compliant."
```

---

## Task 5: The card

**Files:**
- Create: `src/screens/ConsentCardScreen.tsx`
- Modify: `src/navigation/RootNavigator.tsx`

- [ ] **Step 1: Write the screen**

Create `src/screens/ConsentCardScreen.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { NativeModules, View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '../theme/ThemeProvider';
import { Txt, IconButton } from '../components/ui';
import { consentCardText } from './consent';

type Props = NativeStackScreenProps<RootStackParamList, 'ConsentCard'>;

/**
 * The card you hold up to the room.
 *
 * A poster, not a form. No state, no logging, and deliberately no signature capture: collecting
 * names would make this a data-collection feature inside an app whose Play Data Safety entry says
 * no data is collected.
 *
 * Sized for reading across a table rather than at arm's length, which is why the type is far
 * larger than anywhere else in the app.
 */
export default function ConsentCardScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [region, setRegion] = useState<string | null>(null);

  useEffect(() => {
    // Offline: the SIM's network country, falling back to the device locale. Never a network call
    // and never a location permission — see src/screens/consent.ts.
    const mod = NativeModules.AudioPipeline as { regionCode?: () => Promise<string> } | undefined;
    mod?.regionCode?.().then(setRegion).catch(() => setRegion(null));
  }, []);

  const text = consentCardText(region);
  const st = styles(colors);

  return (
    <View style={[st.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}>
      <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
      <View style={st.body}>
        <Txt variant="display" style={st.title}>
          {text.title}
        </Txt>
        <Txt variant="body" color={colors.inkSoft} style={st.para}>
          {text.body}
        </Txt>
      </View>
    </View>
  );
}

const styles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg, paddingHorizontal: 24 },
    body: { flex: 1, justifyContent: 'center' },
    // Deliberately outsized: this is read from the other side of a table.
    title: { fontSize: 40, lineHeight: 46, textAlign: 'center' },
    para: { fontSize: 20, lineHeight: 30, textAlign: 'center', marginTop: 24 },
  });
```

- [ ] **Step 2: Register it**

In `src/navigation/RootNavigator.tsx`, add to `RootStackParamList` after `Notices: undefined;`:

```ts
  /** The card held up to the room. No params: it says the same thing for every meeting. */
  ConsentCard: undefined;
```

Add the import next to the other screen imports:

```ts
import ConsentCardScreen from '../screens/ConsentCardScreen';
```

Add the screen next to `Notices`:

```tsx
          <Stack.Screen
            name="ConsentCard"
            component={ConsentCardScreen}
            options={{ headerShown: false }}
          />
```

- [ ] **Step 3: Add the native region lookup**

In `android/app/src/main/java/com/innocorelabs/verbale/pipeline/AudioPipelineModule.kt`, add
alongside the other `@ReactMethod`s:

```kotlin
  /**
   * The two-letter region for wording the consent card, resolved OFFLINE.
   *
   * The SIM's network country first, because it says where the phone actually is; the device
   * locale second, because a phone with no SIM still has an owner. Never a network call and never
   * a location permission — this app claims one network call a month and intends to keep saying so.
   */
  @ReactMethod
  fun regionCode(promise: Promise) {
    try {
      val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as? android.telephony.TelephonyManager
      val fromSim = tm?.networkCountryIso?.takeIf { it.isNotBlank() }
      val region = fromSim ?: java.util.Locale.getDefault().country
      promise.resolve(region.uppercase())
    } catch (e: Exception) {
      // An unknown region gets the plain card, which is safe everywhere because it says less.
      promise.resolve("")
    }
  }
```

Add `import android.content.Context` at the top if it is not already imported.

- [ ] **Step 4: Typecheck and build**

```bash
npx tsc --noEmit && echo "tsc ok"
export ANDROID_HOME=/Users/akshayghosh/Android/Library/SDK
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home
cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a \
  -PAUDIONOTES_DEBUG_UPLOAD_SIGNING 2>&1 | grep -E 'BUILD|error'
```

Expected: `tsc ok` and `BUILD SUCCESSFUL`.

- [ ] **Step 5: Commit**

```bash
git add src/screens/ConsentCardScreen.tsx src/navigation/RootNavigator.tsx \
        android/app/src/main/java/com/innocorelabs/verbale/pipeline/AudioPipelineModule.kt
git commit -m "feat(consent): a card to show the room

A poster, not a form. No signature capture — collecting names would trade the Data Safety
declaration for a feature nobody asked for."
```

---

## Task 6: Reaching the card, and turning the announcement off

**Files:**
- Modify: `src/screens/RecordScreen.tsx`
- Modify: `src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Link to the card from the consent gate**

In `src/screens/RecordScreen.tsx`, find the consent card's call to action:

```tsx
                <View style={st.consentCta}>
                  <Button
                    label="Everyone's in — let's go"
```

Add directly above that `<View style={st.consentCta}>`:

```tsx
                {/* For a room where talking over people is not practical, or where somebody would
                    rather see it than hear it. */}
                <Txt
                  variant="sub"
                  color={colors.primaryDeep}
                  style={st.consentBody}
                  onPress={() => navigation.navigate('ConsentCard')}>
                  Show the room a card instead
                </Txt>
```

- [ ] **Step 2: Add the Settings toggle**

In `src/screens/SettingsScreen.tsx`, add state next to the other setting state hooks:

```tsx
  const [announceOn, setAnnounceOn] = useState(true);
```

In the same `useEffect` that loads other settings, add:

```tsx
    db.getSetting('announceRecording')
      .then(v => setAnnounceOn(v !== '0'))
      .catch(() => setAnnounceOn(true));
```

Add a row alongside the crash-reporting switch, following that row's markup:

Wrapped exactly like the crash-reporting row it sits beside — `st.rowPad` > `st.row` > icon +
`st.flex` + `Switch`:

```tsx
            <View style={st.list}>
              <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
                <View style={st.rowPad}>
                  <View style={st.row}>
                    <Icon name="mic" size={s(18)} color={colors.inkSoft} strokeWidth={2.4} />
                    <View style={st.flex}>
                      <Txt variant="bodyStrong">Announce out loud</Txt>
                      <Txt variant="meta" color={colors.inkDim}>
                        Says "this meeting is being recorded" into the room when you start, and the
                        recording keeps a copy of it being said, so the file itself shows the room
                        was told. Defaults on everywhere.
                      </Txt>
                    </View>
                    <Switch
                      on={announceOn}
                      onToggle={() => {
                        const next = !announceOn;
                        setAnnounceOn(next);
                        db.setSetting('announceRecording', next ? '1' : '0').catch(() => {});
                      }}
                    />
                  </View>
                </View>
              </Raised>
            </View>
```

If `mic` is not a name in `src/components/Icon.tsx`, use `shield` as the crash row does.

- [ ] **Step 3: Typecheck, lint and test**

```bash
npx tsc --noEmit && npm test 2>&1 | grep -E 'Tests:|Suites:'
npx eslint src/screens/RecordScreen.tsx src/screens/SettingsScreen.tsx \
  src/screens/ConsentCardScreen.tsx src/screens/consent.ts 2>&1 | grep -cE ' error '
```

Expected: no type errors, all tests pass. Compare the eslint count against `main` for the same
files; it must not increase.

- [ ] **Step 4: Commit**

```bash
git add src/screens/RecordScreen.tsx src/screens/SettingsScreen.tsx
git commit -m "feat(consent): reach the card, and turn the announcement off

Defaults on everywhere rather than only in all-party regions: the alternative ships a jurisdiction
map whose stale entries default somebody to silence in a place that required otherwise."
```

---

## Task 7: Verify on hardware

**Files:** none — this is the gate.

- [ ] **Step 1: Confirm a device is attached**

```bash
export ANDROID_HOME=/Users/akshayghosh/Android/Library/SDK
export PATH=$ANDROID_HOME/platform-tools:$PATH
adb devices -l
```

Expected: one line ending `device`.

- [ ] **Step 2: Install and run the native suite**

```bash
npm run test:device
```

Expected: `NativePipelineTest` passes with no skips. This is also the outstanding gate from the
previous feature — `docs/superpowers/plans/2026-09-05-transcribe-it-anyway.md` Task 9 — so run
its manual steps here too if they have not been done.

- [ ] **Step 3: Prove the announcement lands in the recording**

This is the only check that proves the feature does the thing it exists to do.

1. Settings → confirm **Announce out loud** is on.
2. Record 20 seconds: let the announcement play, then say two or three ordinary sentences.
3. Stop, wait for processing.
4. **Confirm the first line of the transcript is the disclosure.** If it is not, the clip is not
   reaching the microphone and the feature is decorative.
5. Export as Markdown and confirm the disclosure is the first line there too.

- [ ] **Step 4: Prove it never lies**

1. Put the phone on silent. Record 10 seconds. Confirm the meeting is **not** stamped as announced
   and the logcat line `announcement not heard: SILENCED` appears:
   ```bash
   adb logcat -d | grep -i 'announcement not heard'
   ```
2. Turn the setting off. Record 10 seconds. Confirm no announcement plays and nothing is logged as
   a failure — switching it off is not an error.

- [ ] **Step 5: Read the card at a table's distance**

Open Record → **Show the room a card instead**. Put the phone flat on a desk and read it standing.
If it cannot be read from a metre away, raise the two font sizes in `ConsentCardScreen`.

- [ ] **Step 6: Commit any fixes and record the state**

In `docs/NEXT.md`, replace item 7's row:

```
| 7 | **The consent kit** — *code complete, **needs the real clip*** | me | S | Merged: the disclosure is spoken into the LIVE microphone, so it lands in the audio and becomes the first line of the transcript — the recording carries its own proof the room was told, and it travels with the exported file. A bundled clip rather than TTS, because Google's TTS synthesises over the network and item 8 claims one network call a month. Defaults on everywhere; region changes the card's wording, never the announcement's. The app reports what it did and never that anybody is compliant. **Outstanding: the shipped clip is a synthesised placeholder and must be replaced with a human recording before launch.** `docs/superpowers/specs/2026-09-05-consent-kit-design.md`. |
```

```bash
git add docs/NEXT.md
git commit -m "docs: the consent kit ships, minus the recorded clip"
```

---

## Task 8: Replace the placeholder clip

Blocked on somebody recording it. Do not merge to a release branch until this is done.

**Files:**
- Modify: `android/app/src/main/res/raw/consent_announcement.wav`

- [ ] **Step 1: Record the sentence**

*"This meeting is being recorded by Verbale. The recording stays on this phone."*

Unhurried, in a quiet room, no music, no processing.

- [ ] **Step 2: Convert to the capture format**

```bash
afconvert -f WAVE -d LEI16@16000 -c 1 <recorded-file> \
  android/app/src/main/res/raw/consent_announcement.wav
ls -l android/app/src/main/res/raw/consent_announcement.wav
```

Expected: mono 16 kHz WAV.

- [ ] **Step 3: Re-run the device check**

Repeat Task 7 Step 3. The transcript's first line must still be the disclosure — a quieter or
faster recording can stop being transcribed cleanly.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/res/raw/consent_announcement.wav
git commit -m "feat(consent): the announcement, in a human voice"
```

---

## Self-review

**Spec coverage.** The announcement → Tasks 1, 3. Bundled-not-TTS and its reasoning → Task 1. Never
claiming what did not happen → Task 1 (`Outcome.wasHeard`), Task 2 (the stamp), Task 7 Step 4 (the
proof). The card → Tasks 4, 5, 6. Defaults on everywhere → Task 6. Region offline, card wording only
→ Tasks 4, 5. No legal advice → Task 4's final test, which asserts the words "legal" and "complian"
never appear. The `UNPROCESSED` comment the spec requires → Task 3 Step 1. The asset dependency →
Tasks 1 Step 4 and 8.

**Type consistency.** `AnnouncementPlayer.Outcome` with `wasHeard()`/`userMessage()` is defined in
Task 1 and used in Task 3. `announced_at` is the column (Task 2) and `markAnnounced`/`announcedAt`
its accessors (Tasks 2, 3). `consentCardText` and `GDPR_REGIONS` are defined in Task 4 and used in
Tasks 4 and 5. The setting key is `announceRecording` in Task 3 (read) and Task 6 (written).
`regionCode` is the bridge method in Task 5, called from `ConsentCardScreen` in the same task.

**Both soft edges resolved during review.** The service's field is `meetingId`
(`RecordingService.kt:69`), and the Settings row markup is `st.rowPad` > `st.row` > `Icon` +
`st.flex` + `Switch`, copied from the crash-reporting row at `SettingsScreen.tsx:851-869`. Neither
is left for the implementer to guess.

**Not covered by any automated test, by nature.** That the clip is audible in the recorded audio,
and that the card is legible across a table. Task 7 Steps 3 and 5 are the only checks for either,
and Step 3 is the one that decides whether the feature is real or decorative.
