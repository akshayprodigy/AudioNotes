import React, { useEffect, useMemo, useState } from 'react';
import { NativeEventEmitter, NativeModules, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import ModelManager from '../native/NativeModelManager';
import AudioPipeline from '../native/NativeAudioPipeline';
import Licence from '../native/NativeLicence';
import Icon, { type IconName } from '../components/Icon';
import Mascot from '../components/Mascot';
import { Button, Pop, ProgressBar, Raised, SoftButton, Switch, Txt } from '../components/ui';
import { db } from '../db/queries';
import SignInForm from '../billing/SignInForm';
import { TRIAL_DAYS, startTrial } from '../billing/trial';
import { radius, s, sv, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

/**
 * What first run has to fetch, read from the catalog rather than listed here.
 *
 * The duplicate list this replaces had already drifted once — it named four models by id with
 * their own labels, so adding or renaming one in ModelCatalog silently left onboarding fetching
 * the wrong set. The catalog marks which models a meeting cannot be processed without; this asks
 * it, and shows the same wording Settings does.
 *
 * Diarization is in that required set deliberately. Excluding it kept first run at ~60 MB, but a
 * new user then recorded a meeting, got a transcript with no speaker labels, and had no way to
 * discover that "who said what" — a headline feature — sat behind a Settings screen they had
 * never opened.
 */
type Essential = {
  id: string;
  purpose: string;
  sizeBytes: number;
  kind: string;
  required: boolean;
  needsSubscription: boolean;
  installed: boolean;
};

const BULLETS: { icon: IconName; title: string; body: string; tone: 'primary' | 'success' | 'warning' }[] = [
  {
    icon: 'shield',
    title: 'Private by design',
    body: 'Recording, transcription and notes all happen on your phone.',
    tone: 'primary',
  },
  {
    icon: 'mic',
    // Describes the Picture-in-Picture window that shipped, not the floating overlay bubble it
    // replaced. The bubble needed the "draw over other apps" permission and is gone; PiP is a
    // system window the recorder puts itself into, with its own stop and pause controls, and it
    // needs no special permission at all. Copy that still promised a bubble was describing an
    // app the user does not have.
    title: 'Record any meeting',
    body: 'Keeps recording with the screen off, or in a small window over whatever app you open.',
    tone: 'success',
  },
  {
    icon: 'users',
    title: 'Knows who spoke',
    body: 'Separates voices and pulls out decisions and action items.',
    tone: 'warning',
  },
];

export default function OnboardingScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<'intro' | 'downloading' | 'done' | 'failed'>('intro');
  const [pct, setPct] = useState(0);
  const [step, setStep] = useState(0);
  const [current, setCurrent] = useState('');
  const [essentials, setEssentials] = useState<Essential[]>([]);
  /**
   * What this run is actually downloading, frozen at the moment the button was pressed.
   *
   * The progress line used to read "6 of 5": it counted `essentials` while the loop walked
   * `chosen`, which is `essentials` PLUS the writer model when a subscriber leaves that switch
   * on. Two lists describing one download will always drift, so there is now one — the loop and
   * the counter read the same array, and it cannot change underneath them if the licence check
   * or the catalog resolves late.
   */
  const [plan, setPlan] = useState<Essential[]>([]);
  const [writer, setWriter] = useState<Essential[]>([]);
  // The rest of what a subscription pays for — today that is whisper-small alone. Separate from
  // `writer` because the switch belongs to the writer: the Pro screen sells the larger
  // transcriber as part of the subscription, not as something to turn off.
  const [proExtras, setProExtras] = useState<Essential[]>([]);
  // Whether the writer model may be fetched at all. ModelManager.download refuses it without a
  // subscription — that refusal is the enforcement — so offering the switch to someone who has
  // not subscribed would be offering a button that cannot work.
  //
  // On a first run this is always false, which makes the opening download 114 MB instead of
  // 1.2 GB. That is a better first impression than the one it replaces, not a worse one.
  const [paid, setPaid] = useState(false);
  const [wantWriter, setWantWriter] = useState(false);
  // Which tier was picked at setup. null means they have not been asked yet, which is the state
  // the intro sits in until they choose.
  const [tier, setTier] = useState<'free' | 'pro' | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);

  useEffect(() => {
    Licence.status()
      .then(entitlement => {
        setPaid(entitlement.paid);
        // Defaulted on for a subscriber: a meeting app whose minutes read like a word count is
        // not the product, and this model is what turns a transcript into something anyone will
        // actually read. Off is one tap away.
        setWantWriter(entitlement.paid);
      })
      .catch(() => {});
    ModelManager.list()
      .then(r => {
        const all: Essential[] = JSON.parse(r);
        setEssentials(all.filter(m => m.required));
        setWriter(all.filter(m => !m.required && m.kind === 'llm'));
        // Read from needsSubscription — the catalog's own rule — rather than testing `kind`
        // again here. This screen used to select the paid models with `kind === 'llm'` alone,
        // which is a second copy of a rule the catalog already owns, and it had drifted: the
        // Pro screen advertises "The larger transcriber" and neither path that starts a trial
        // ever downloaded it. whisper-small was reachable only by finding it in Settings.
        setProExtras(all.filter(m => !m.required && m.needsSubscription && m.kind !== 'llm'));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.ModelManager);
    const sub = emitter.addListener('onModelProgress', (e: { total: number; downloaded: number }) => {
      if (e.total > 0) setPct(Math.round((e.downloaded / e.total) * 100));
    });
    return () => sub.remove();
  }, []);

  // What the button will actually cost, including the writer when it is switched on. Saying
  // "112 MB" and then downloading 1.2 GB is the kind of surprise that gets an app uninstalled.
  //
  // Anything already on disk costs nothing, and must not be counted. Coming back to this screen
  // with every model present offered "Download the AI (114 MB)" — a number that was wrong in the
  // direction that makes the app look worse, and which used to be true because download() really
  // did fetch them all again. That is fixed natively; this is the half the user reads.
  /** Entitled to the paid models, either already or by the trial just started. */
  const proChosen = paid || tier === 'pro';

  const chosen = proChosen
    ? [...essentials, ...proExtras, ...(wantWriter ? writer : [])]
    : essentials;
  const totalMb = Math.round(
    chosen.filter(m => !m.installed).reduce((a, m) => a + m.sizeBytes, 0) / 1e6,
  );
  const writerMb = Math.round(writer.reduce((a, m) => a + m.sizeBytes, 0) / 1e6);
  /** What taking Pro adds over free, which is more than the writer on its own. */
  const proMb = Math.round(
    [...proExtras, ...writer].reduce((a, m) => a + m.sizeBytes, 0) / 1e6,
  );

  /**
   * Taking Pro at setup starts the TRIAL, not a purchase.
   *
   * Asking for a card before the app has transcribed a single meeting is the weakest possible ask,
   * and the trial is the only honest answer to "is it any good on MY meetings" — the only question
   * that matters for this product. Buying outright stays on the Pro screen and in Settings.
   *
   * A trial that fails to start drops to free rather than dead-ending setup. A first run that
   * cannot proceed because a billing helper threw is a far worse outcome than a missing trial.
   */
  const choosePro = async () => {
    try {
      await startTrial();
      setTier('pro');
      setWantWriter(true);
    } catch {
      setTier('free');
      setWantWriter(false);
    }
  };

  const finish = async () => {
    await db.setSetting('onboarded', '1');
    navigation.replace('Library');
  };

  /**
   * A failure here has to be visible. The old version swallowed every error and went straight to
   * "All set", so a first run on a bad connection landed the user in an empty library with an app
   * that could record but never transcribe, and nothing anywhere saying why.
   */
  const downloadAll = async () => {
    // Captured into a local as well as into state: the loop must not read a render-time value
    // that a re-render could change under it, and setPlan's result is not visible in this pass.
    const queue = chosen;
    setPlan(queue);
    setStatus('downloading');
    AudioPipeline.requestBatteryExemption().catch(() => {});
    for (let i = 0; i < queue.length; i++) {
      setStep(i);
      setCurrent(queue[i].purpose);
      setPct(0);
      try {
        await ModelManager.download(queue[i].id);
      } catch {
        // Only a REQUIRED model can fail the setup. Losing the writer means minutes pulled out by
        // rule instead of written as prose — a smaller app, not a broken one — and it can be
        // fetched later from Settings. Failing the whole first run over it would be a lie about
        // how badly things went.
        if (queue[i].required) {
          setStatus('failed');
          return;
        }
      }
    }
    // Mark setup finished HERE, not only in finish(). The flag used to be written solely when the
    // user tapped "Start recording" on the last screen, so anyone who got their models and then
    // backgrounded the app came back to onboarding — offering to download what they already had.
    // Reaching this line is what "onboarded" means; the last screen is a greeting, not a step.
    await db.setSetting('onboarded', '1').catch(() => {});
    setStatus('done');
  };

  const pad = { paddingTop: insets.top + s(10), paddingBottom: insets.bottom + s(20) };

  if (status === 'downloading') {
    return (
      <View style={[st.root, st.center, pad]}>
        <Mascot mood="thinking" size={sv(140)} />
        <Txt variant="display" style={st.mt}>
          Getting things ready
        </Txt>
        <Txt variant="meta" color={colors.inkDim} style={st.sub}>
          Downloading once. After this, recording and transcription never need the network.
        </Txt>
        <View style={st.progress}>
          <View style={st.progressHead}>
            <Txt variant="bodyStrong">{current}</Txt>
            <Txt variant="chip" color={colors.inkFaint}>
              {step + 1} of {plan.length}
            </Txt>
          </View>
          <ProgressBar pct={pct} color={colors.primary} track={colors.cardAlt} />
        </View>
      </View>
    );
  }

  if (status === 'failed') {
    return (
      <View style={[st.root, st.center, pad]}>
        <Mascot mood="thinking" size={sv(140)} />
        <Txt variant="display" style={st.mt}>
          That download stopped
        </Txt>
        <Txt variant="body" color={colors.inkSoft} style={[st.sub, st.failBody]}>
          “{current}” could not be fetched. Check your connection and try again — anything already
          downloaded is kept, so it picks up where it left off.
        </Txt>
        <View style={st.failCta}>
          <Button label="Try again" icon="refresh" onPress={downloadAll} full />
          <View style={st.skipRow}>
            <SoftButton label="Continue without it" onPress={finish} />
          </View>
        </View>
      </View>
    );
  }

  if (status === 'done') {
    return (
      <View style={[st.root, st.center, pad]}>
        <Pop>
          <Mascot mood="happy" size={sv(150)} />
        </Pop>
        <Pop index={1} style={st.doneWrap}>
          <Txt variant="screenTitle" style={st.centerText}>
            All set
          </Txt>
          <Txt variant="body" color={colors.inkSoft} style={[st.centerText, st.sub]}>
            Pip is ready to sit in on your next meeting.
          </Txt>
          <View style={st.cta}>
            <Button label="Start recording" icon="mic" onPress={finish} full />
          </View>
        </Pop>
      </View>
    );
  }

  return (
    // A ScrollView, not a View. This screen is the tallest in the app and on a 6" phone its
    // content is ~50dp taller than the viewport. In a plain View the only give was `list`'s
    // `flex: 1` — which in React Native also means `flexShrink: 1` — so Yoga squeezed the page
    // to fit by collapsing the hero title to zero height and pushing the third bullet out of
    // the shrunken list box, where the footer's opaque card painted over it. Both were silent.
    <ScrollView
      style={st.root}
      contentContainerStyle={[st.scrollBody, pad]}
      showsVerticalScrollIndicator={false}>
      <View style={st.hero}>
        <Pop>
          <Mascot mood="idle" size={sv(132)} />
        </Pop>
        {/* alignSelf: stretch, not the hero's default centring. Centred, this block shrinks to
            fit and the subtitle gets measured at one width and laid out at a narrower one, so it
            wrapped to two lines inside a box only one line tall — "note-taker" was clipped away
            with no ellipsis to hint at it. Both lines are textAlign: 'center' already, so taking
            the full column changes nothing visually. Same reason doneWrap stretches. */}
        <Pop index={1} style={st.heroText}>
          <Txt variant="screenTitle" style={st.centerText}>
            Verbale
          </Txt>
          <Txt variant="label" color={colors.inkDim} style={st.centerText}>
            Your private meeting note-taker
          </Txt>
        </Pop>
      </View>

      {/*
          The tier choice sits under the hero and ABOVE the bullets, because it has to be on the
          first screen without scrolling.

          It read better below them — learn what the app does, then choose — but on a Pixel 7 Pro
          that put "Try Pro free for 7 days" roughly 70px past the bottom edge. The only visible
          option was "Start free", so the choice this step exists to offer was invisible on one of
          the taller phones on the market, and worse on anything smaller. The bullets still sell
          the app; they now do it underneath the choice.
      */}
      {tier === null ? (
        <Pop index={2} style={st.tierChoice}>
          <Button
            label="Start free"
            icon="download"
            onPress={() => setTier('free')}
            disabled={essentials.length === 0}
            full
          />
          <View style={st.tierGap}>
            <SoftButton label={`Try Pro free for ${TRIAL_DAYS} days`} icon="ai" onPress={choosePro} />
          </View>
          <Txt variant="chip" color={colors.inkFaint} style={[st.centerText, st.note]}>
            Free records, transcribes and pulls out the decisions and actions — no account, for as
            long as you use it. Pro writes the minutes as prose, transcribes with a larger model,
            and downloads {proMb} MB more.
          </Txt>
        </Pop>
      ) : null}

      <View style={st.list}>
        {BULLETS.map((b, i) => (
          <Pop key={b.title} index={i + 2}>
            <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={6}>
              <View style={st.bullet}>
                <View style={[st.bulletIcon, { backgroundColor: colors[`${b.tone}Soft`] }]}>
                  <Icon name={b.icon} size={s(20)} color={colors[b.tone]} strokeWidth={2.4} />
                </View>
                <View style={st.flex}>
                  <Txt variant="cardTitleSm">{b.title}</Txt>
                  <Txt variant="chip" color={colors.inkSoft} style={st.bulletBody}>
                    {b.body}
                  </Txt>
                </View>
              </View>
            </Raised>
          </Pop>
        ))}
      </View>

      <Pop index={5} style={st.footer}>
        {writer.length > 0 ? (
          <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
            <View style={st.bullet}>
              <View style={[st.bulletIcon, { backgroundColor: colors.primarySoft }]}>
                <Icon name="edit" size={s(20)} color={colors.primary} strokeWidth={2.4} />
              </View>
              <View style={st.flex}>
                <Txt variant="cardTitleSm">Write the minutes in plain English</Txt>
                <Txt variant="chip" color={colors.inkSoft} style={st.bulletBody}>
                  {proChosen
                    ? `Adds ${writerMb} MB. Without it you still get minutes, pulled out by rule rather than written as prose.`
                    : `Part of the subscription — a ${writerMb} MB model that runs on your phone. You still get minutes without it, pulled out by rule rather than written as prose.`}
                </Txt>
              </View>
              {/* No switch when there is nothing to switch on. A control that reports a
                  subscription error on tap is worse than an honest sentence. */}
              {proChosen ? <Switch on={wantWriter} onToggle={() => setWantWriter(v => !v)} /> : null}
            </View>
          </Raised>
        ) : null}
        {/* The rest of the paid set, once Pro is taken. Without this the button reads
            "Download (1421 MB)" while the only card above it accounts for 1117 of them, and the
            missing 190 has no explanation anywhere on the screen — the same surprise the total
            above is calculated to avoid. No switch: this one is not optional within Pro. */}
        {proChosen
          ? proExtras.map(m => (
              <Raised
                key={m.id}
                edge={colors.line}
                fill={colors.card}
                rad={radius.card}
                depth={5}>
                <View style={st.bullet}>
                  <View style={[st.bulletIcon, { backgroundColor: colors.primarySoft }]}>
                    <Icon name="mic" size={s(20)} color={colors.primary} strokeWidth={2.4} />
                  </View>
                  <View style={st.flex}>
                    <Txt variant="cardTitleSm">{m.purpose}</Txt>
                    <Txt variant="chip" color={colors.inkSoft} style={st.bulletBody}>
                      Adds {Math.round(m.sizeBytes / 1e6)} MB.
                    </Txt>
                  </View>
                </View>
              </Raised>
            ))
          : null}
        {/*
            The choice itself is above the bullets; what stays down here is the way back in for
            somebody who has already paid — on the website, or on a previous phone. It belongs
            below the fold in a way the choice does not: it is the rare case, and putting it
            beside the two tier buttons would read as a third option for a new install.
        */}
        {tier === null ? (
          <View style={st.tierGap}>
            {showSignIn ? (
              <SignInForm
                onSignedIn={res => {
                  if (res.paid) {
                    setTier('pro');
                    setWantWriter(true);
                  }
                }}
              />
            ) : (
              <SoftButton
                label="Already subscribed? Sign in"
                icon="lock"
                onPress={() => setShowSignIn(true)}
              />
            )}
          </View>
        ) : (
          <Button
            label={totalMb > 0 ? `Download (${totalMb} MB)` : 'Download'}
            icon="download"
            onPress={downloadAll}
            disabled={chosen.length === 0}
            full
          />
        )}
        {/* Said plainly, before the tap. The models are not in the app — shipping them would put
            it well past a gigabyte on the store — so this download is what makes the app work at
            all.

            It used to say this was "the only time the app touches the network" and that everything
            worked "offline, forever". Neither survived the subscription: a paid install checks its
            licence every week or so. That check carries an account id and a device id and nothing
            else — no recording, no transcript, no title, not even a count — so the sentence that
            actually matters is still true and is the one left standing. Overclaiming the rest
            would trade a privacy promise for a line of copy, and this app has nothing else to
            sell. */}
        <Txt variant="chip" color={colors.inkFaint} style={[st.centerText, st.note]}>
          The speech models are not bundled in the app, so they download once. After that your
          recordings, transcripts and minutes are all made on this phone — none of it is ever
          uploaded.
        </Txt>
        <View style={st.skipRow}>
          <SoftButton label="Later, from Settings" onPress={finish} />
        </View>
      </Pop>
    </ScrollView>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas, paddingHorizontal: s(22) },
    flex: { flex: 1 },
    center: { alignItems: 'center', justifyContent: 'center' },
    centerText: { textAlign: 'center' },
    hero: { alignItems: 'center', paddingTop: s(10), gap: s(6) },
    heroText: { alignSelf: 'stretch' },
    scrollBody: { flexGrow: 1 },
    // Grow to centre the bullets on a tall screen, but NEVER shrink: shrinking is what
    // pushed a card under the footer. Past the viewport the ScrollView scrolls instead.
    list: { flexGrow: 1, flexShrink: 0, justifyContent: 'center', gap: s(12), marginTop: s(18) },
    bullet: { flexDirection: 'row', alignItems: 'flex-start', gap: s(14), padding: s(16) },
    bulletIcon: {
      width: s(44),
      height: s(44),
      borderRadius: radius.lg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bulletBody: { marginTop: s(3) },
    footer: { gap: s(8) },
    note: { marginTop: s(4) },
    tierGap: { marginTop: s(10) },
    tierChoice: { marginTop: s(18) },
    skipRow: { flexDirection: 'row' },
    mt: { marginTop: s(22) },
    sub: { marginTop: s(6), textAlign: 'center' },
    progress: { alignSelf: 'stretch', marginTop: s(30), gap: s(8) },
    progressHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    doneWrap: { alignSelf: 'stretch', marginTop: s(20) },
    cta: { marginTop: s(22) },
    failBody: { paddingHorizontal: s(10) },
    failCta: { alignSelf: 'stretch', marginTop: s(26), gap: s(10) },
  });
}
