import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import ModelManager from '../native/NativeModelManager';
import Licence from '../native/NativeLicence';
import Icon, { type IconName } from '../components/Icon';
import Mascot from '../components/Mascot';
import { Button, Pop, ProgressBar, Raised, SoftButton, Switch, Txt } from '../components/ui';
import { downloadLabel, downloadPct } from './downloadLabel';
import { autoStartDownloads, runDownloads, useDownloadStore } from '../setup/essentialDownload';
import { SAMPLE_ID } from '../sample/sampleId';
import { seedSample } from '../sample/seedSample';
import FirstRecordingNote from '../setup/FirstRecordingNote';
import { runnable, sizeMb, spaceFits, spaceReason, writerBlockedReason, type DeviceFit } from './deviceFit';
import { db } from '../db/queries';
import SignInForm from '../billing/SignInForm';
import { crashReportingAvailable, setCrashConsent } from '../telemetry/crash';
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
  unsupportedReason?: string | null;
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
  // The download itself lives in src/setup/essentialDownload, outside this screen: the Library's
  // readiness card and the Record screen read the same run, so leaving this screen mid-download
  // (or skipping, or the process dying) leaves something the rest of the app can see and resume.
  // What this screen shows of it is the megabytes rather than a percentage, because the first-run
  // download is 114 MB and the writer, if it is switched on, adds 1.1 GB. See downloadLabel.
  const run = useDownloadStore();
  const bytes = run.live ?? { downloaded: 0, total: 0 };
  const [essentials, setEssentials] = useState<Essential[]>([]);
  /**
   * Writer-kind and larger-transcriber models are NOT in the first screen's plan. They are what
   * Pro adds, and they appear under "More options" for a phone that can run them or a subscriber.
   */
  const [writer, setWriter] = useState<Essential[]>([]);
  // The rest of what a subscription pays for — today that is whisper-small alone. Separate from
  // `writer` because the switch belongs to the writer: the Pro screen sells the larger
  // transcriber as part of the subscription, not as something to turn off.
  const [proExtras, setProExtras] = useState<Essential[]>([]);
  // The sentence this phone gets instead of the writer's switch — null on a phone that can run it.
  // Read from the catalog rows (composed natively, the memory in the GB the phone was sold as) so
  // this screen never offers a 1.1 GB download the phone cannot use. The meaning index, the other
  // `llm`-kind model, runs anywhere and stays in the plan.
  const writerBlocked = writerBlockedReason(writer);
  // The phone itself: whether the engines can run on its processor at all, and the disk that is
  // free. null until native answers; the button waits for it rather than offer a download that
  // would be refused on the tap.
  const [fit, setFit] = useState<DeviceFit | null>(null);
  // Whether the writer model may be fetched at all. ModelManager.download refuses it without a
  // subscription — that refusal is the enforcement — so offering the switch to someone who has
  // not subscribed would be offering a button that cannot work.
  //
  // On a first run this is false, which makes the opening download 114 MB instead of 1.2 GB.
  const [paid, setPaid] = useState(false);
  const [wantWriter, setWantWriter] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  const [sampleFailed, setSampleFailed] = useState(false);
  // Off until tapped. Consent that starts switched on is not consent, and this one is about
  // network traffic leaving a device whose entire selling point is that none does.
  const [crashOptIn, setCrashOptIn] = useState(false);

  // Back from the Pro screen: a purchase made there is read here and setup carries on as Pro —
  // the primary button then fetches the writer with everything else.
  useEffect(
    () =>
      navigation.addListener('focus', () => {
        Licence.status()
          .then(e => {
            if (!e.paid) return;
            setPaid(true);
            setWantWriter(true);
          })
          .catch(() => {});
      }),
    [navigation],
  );

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
        // again here: a second copy of a rule the catalog already owns is how the Pro screen came
        // to advertise a transcriber no path ever downloaded.
        setProExtras(all.filter(m => !m.required && m.needsSubscription && m.kind !== 'llm'));
      })
      .catch(() => {});
    Promise.resolve()
      .then(() => ModelManager.deviceFit())
      .then(r => setFit(JSON.parse(r)))
      .catch(() => setFit({ cpuReason: null, freeBytes: Number.MAX_SAFE_INTEGER }));
  }, []);

  /** Entitled to the paid models: already, or by a purchase just made on the Pro screen. */
  const proChosen = paid;

  // What the button will actually cost. Anything already on disk costs nothing and is not counted:
  // offering "Download (114 MB)" for what is already here is wrong in the direction that makes
  // the app look worse.
  const chosen = proChosen
    ? runnable([...essentials, ...proExtras, ...(wantWriter ? writer : [])])
    : essentials;
  const pending = chosen.filter(m => !m.installed);
  const totalMb = sizeMb(pending);
  const writerMb = sizeMb(runnable(writer));
  // Everything this plan would fetch is already here (a return visit, or setup finished in
  // another session): there is nothing to set up, only to start.
  const alreadySetUp = chosen.length > 0 && pending.length === 0;
  // The disk sentence for THIS plan, or null. Said in place of the button, because a button that
  // fails on the tap with the same sentence is a worse version of the sentence.
  const pendingBytes = pending.reduce((a, m) => a + m.sizeBytes, 0);
  const spaceShort =
    fit !== null && pendingBytes > 0 && !spaceFits(pendingBytes, fit.freeBytes)
      ? spaceReason(proChosen ? 'the Pro models' : 'the speech models', pendingBytes, fit.freeBytes)
      : null;
  // The download starts by itself as soon as the catalog and the phone's fit are known. It is not
  // a choice: skipping it only ever led to an error after the first recording.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || status !== 'intro' || !fit || fit.cpuReason || spaceShort) return;
    const todo = essentials.filter(m => !m.installed);
    if (todo.length === 0) return;
    autoStarted.current = true;
    autoStartDownloads(todo);
    setStatus('downloading');
  }, [essentials, fit, status, spaceShort]);

  // The run lives outside this screen, so its end is read from the store.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (run.running) wasRunning.current = true;
    else if (wasRunning.current && status === 'downloading') {
      wasRunning.current = false;
      if (run.failed) setStatus('failed');
      else {
        db.setSetting('onboarded', '1').catch(() => {});
        setStatus('done');
      }
    }
  }, [run.running, run.failed, status]);

  // More options is for what is relevant: a phone that can run the writer, or a subscriber.
  const hasMore = (writer.length > 0 && !writerBlocked) || proChosen;

  /** The Pro screen, where Play's free trial is offered with its terms. Not a step of setup. */
  const openPro = () => navigation.navigate('Paywall', { from: 'onboarding' });

  /** The sample is a meeting already on the phone: opening it downloads nothing. */
  const openSample = () => {
    setSampleFailed(false);
    seedSample()
      .then(() => navigation.navigate('Meeting', { meetingId: SAMPLE_ID }))
      .catch(() => setSampleFailed(true));
  };

  /** Leave setup for the Library, models or not: the readiness card there is the way back. */
  const skip = async () => {
    await db.setSetting('onboarded', '1');
    navigation.replace('Library');
  };

  /**
   * Setup finished: the recorder, with the Library underneath it so Back lands somewhere. The
   * Library used to be where this ended, and a new user had then to find the record button.
   */
  const startRecording = async () => {
    await db.setSetting('onboarded', '1');
    navigation.reset({ index: 1, routes: [{ name: 'Library' }, { name: 'Record' }] });
  };

  /**
   * A failure here has to be visible. The old version swallowed every error and went straight to
   * "All set", so a first run on a bad connection landed the user in an empty library with an app
   * that could record but never transcribe, and nothing anywhere saying why.
   */
  const downloadAll = async () => {
    setStatus('downloading');
    const ok = await runDownloads(chosen.filter(m => !m.installed));
    if (!ok) {
      setStatus('failed');
      return;
    }
    // Mark setup finished HERE, not only when the person taps the last button. The flag used to
    // be written only on that tap, so anyone who got their models and then backgrounded the app
    // came back to onboarding — offering to download what they already had.
    await db.setSetting('onboarded', '1').catch(() => {});
    setStatus('done');
  };

  const pad = { paddingTop: insets.top + s(10), paddingBottom: insets.bottom + s(20) };

  if (status === 'downloading') {
    return (
      <View style={[st.root, st.center, pad]}>
        <Mascot mood="thinking" size={sv(140)} />
        <Txt variant="display" style={st.mt}>
          Preparing your app
        </Txt>
        <Txt variant="meta" color={colors.inkDim} style={st.sub}>
          Setting up the on-device speech models, one time only. Keep the app open; recording works offline after this.
        </Txt>
        <View style={st.progress}>
          <View style={st.progressHead}>
            <Txt variant="bodyStrong">{run.current}</Txt>
            <Txt variant="chip" color={colors.inkFaint}>
              {run.step + 1} of {run.of}
            </Txt>
          </View>
          <ProgressBar
            pct={downloadPct(bytes.downloaded, bytes.total)}
            color={colors.primary}
            track={colors.cardAlt}
          />
          <Txt variant="chip" color={colors.inkFaint}>
            {downloadLabel(bytes.downloaded, bytes.total)}
          </Txt>
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
          “{run.failedPurpose}” could not be fetched. Check your connection and try again — anything
          already downloaded is kept, so it picks up where it left off.
        </Txt>
        <View style={st.failCta}>
          <Button label="Try again" icon="refresh" onPress={downloadAll} full />
          <View style={st.skipRow}>
            <SoftButton label="Continue without it" onPress={skip} />
          </View>
          <Txt variant="chip" color={colors.inkFaint} style={st.centerText}>
            You can finish this later: the Library shows how far it got and a button to resume.
          </Txt>
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
          {/* Before the first real recording: the language and the Free allowance, once, in the
              words every other surface uses. Not a plan decision, a fact. */}
          <View style={st.doneCard}>
            <FirstRecordingNote paid={paid} />
          </View>
          {/* Asked here rather than only in Settings, because a diagnostics switch nobody finds
              produces no diagnostics — and the reason to have it is a native crash on a phone we
              will never hold. Asked once, off until tapped, and changeable later in Settings.
              Absent entirely when the build has no DSN. */}
          {crashReportingAvailable() ? (
            <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
              <View style={st.bullet}>
                <View style={[st.bulletIcon, { backgroundColor: colors.primarySoft }]}>
                  <Icon name="shield" size={s(20)} color={colors.primary} strokeWidth={2.4} />
                </View>
                <View style={st.flex}>
                  <Txt variant="cardTitleSm">Send crash reports</Txt>
                  <Txt variant="chip" color={colors.inkSoft} style={st.bulletBody}>
                    Technical details only, and only if it crashes. Your recordings, transcripts
                    and minutes stay on this phone either way.
                  </Txt>
                </View>
                <Switch
                  on={crashOptIn}
                  onToggle={() => {
                    const next = !crashOptIn;
                    setCrashOptIn(next);
                    setCrashConsent(next).catch(() => {});
                  }}
                />
              </View>
            </Raised>
          ) : null}
          <View style={st.cta}>
            <Button label="Start recording" icon="mic" onPress={startRecording} full />
          </View>
        </Pop>
      </View>
    );
  }

  if (fit?.cpuReason) {
    return (
      <View style={[st.root, st.center, pad]}>
        <Mascot mood="asleep" size={sv(140)} />
        <Txt variant="display" style={st.mt}>
          Not this phone
        </Txt>
        <Txt variant="body" color={colors.inkSoft} style={[st.sub, st.failBody]}>
          {fit.cpuReason}
        </Txt>
      </View>
    );
  }

  return (
    // A ScrollView, not a View. This screen is the tallest in the app and on a 6" phone its
    // content is taller than the viewport. In a plain View the only give was `list`'s `flex: 1` —
    // which in React Native also means `flexShrink: 1` — so Yoga squeezed the page to fit by
    // collapsing the hero title to zero height. Both were silent.
    <ScrollView
      style={st.root}
      contentContainerStyle={[st.scrollBody, pad]}
      showsVerticalScrollIndicator={false}>
      {/* The Pro entry: always reachable, never a step. It opens the existing Pro screen. */}
      <View style={st.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="See Verbale Pro"
          onPress={openPro}
          style={st.proLink}>
          <Icon name="ai" size={s(16)} color={colors.primaryDeep} strokeWidth={2.4} />
          <Txt variant="chip" color={colors.primaryDeep}>
            Pro
          </Txt>
        </Pressable>
      </View>

      <View style={st.hero}>
        <Pop>
          <Mascot mood="idle" size={sv(132)} />
        </Pop>
        {/* alignSelf: stretch, not the hero's default centring. Centred, this block shrinks to
            fit and the subtitle gets measured at one width and laid out at a narrower one, so it
            wrapped to two lines inside a box only one line tall. */}
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
          ONE primary action, and it is the whole decision: set up, with the size in the label.
          There is no plan to choose here. The sample below shows what the app produces without
          downloading anything, and the Pro link above is where the paid half is explained.
      */}
      <Pop index={2} style={st.tierChoice}>
        {spaceShort && !alreadySetUp ? (
          <Txt variant="chip" color={colors.warning} style={[st.centerText, st.note]}>
            {spaceShort}
          </Txt>
        ) : (
          <Button
            label={
              alreadySetUp
                ? 'Start recording'
                : totalMb > 0
                  ? `Set up private recording — ${totalMb} MB`
                  : 'Set up private recording'
            }
            icon={alreadySetUp ? 'mic' : 'download'}
            onPress={alreadySetUp ? startRecording : downloadAll}
            disabled={chosen.length === 0 || fit === null}
            full
          />
        )}
        {alreadySetUp ? null : (
          <Txt variant="chip" color={colors.inkFaint} style={[st.centerText, st.note]}>
            {totalMb > 0 ? `${totalMb} MB, downloaded once. ` : ''}The speech models are not bundled in
            the app. After that your recordings, transcripts and minutes are all made on this phone —
            none of it is ever uploaded.
          </Txt>
        )}
        <View style={st.tierGap}>
          <SoftButton label="See a sample meeting first" icon="play" onPress={openSample} />
        </View>
        {sampleFailed ? (
          <Txt variant="chip" color={colors.warning} style={[st.centerText, st.note]}>
            The sample could not be opened. Setting up still works.
          </Txt>
        ) : null}
      </Pop>

      <View style={st.list}>
        {BULLETS.map((b, i) => (
          <Pop key={b.title} index={i + 3}>
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

      <Pop index={6} style={st.footer}>
        {hasMore ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: moreOpen }}
            accessibilityLabel={moreOpen ? 'Hide more options' : 'More options'}
            onPress={() => setMoreOpen(v => !v)}
            style={st.moreRow}>
            <Txt variant="chip" color={colors.primaryDeep}>
              {moreOpen ? 'Fewer options' : 'More options'}
            </Txt>
            <Icon name={moreOpen ? 'chevronUp' : 'chevronDown'} size={s(16)} color={colors.primaryDeep} strokeWidth={2.4} />
          </Pressable>
        ) : null}
        {moreOpen && hasMore ? (
          <>
            {writer.length > 0 ? (
              <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
                <View style={st.bullet}>
                  <View style={[st.bulletIcon, { backgroundColor: writerBlocked ? colors.warningSoft : colors.primarySoft }]}>
                    <Icon name="edit" size={s(20)} color={writerBlocked ? colors.warning : colors.primary} strokeWidth={2.4} />
                  </View>
                  <View style={st.flex}>
                    <Txt variant="cardTitleSm">Write the minutes in plain English</Txt>
                    <Txt variant="chip" color={colors.inkSoft} style={st.bulletBody}>
                      {writerBlocked
                        ? `${writerBlocked} The minutes here are pulled out by rule, and everything else in Pro works on this phone.`
                        : proChosen
                          ? `Adds ${writerMb} MB. Without it you still get minutes, pulled out by rule rather than written as prose.`
                          : `Part of Pro — a ${writerMb} MB model that runs on your phone. You still get minutes without it, pulled out by rule rather than written as prose.`}
                    </Txt>
                  </View>
                  {/* No switch when there is nothing to switch on, or when the phone cannot run
                      the model: an honest sentence beats a control that reports an error. */}
                  {proChosen && !writerBlocked ? <Switch on={wantWriter} onToggle={() => setWantWriter(v => !v)} /> : null}
                </View>
              </Raised>
            ) : null}
            {/* The rest of the paid set, once Pro is taken. Without this the button reads a total
                the cards above do not add up to. No switch: this one is not optional within Pro. */}
            {proChosen
              ? proExtras.map(m => (
                  <Raised key={m.id} edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
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
            {/* The way back in for somebody who has already paid — on the website, or on a
                previous phone. */}
            {!proChosen ? (
              <View style={st.tierGap}>
                {showSignIn ? (
                  <SignInForm
                    onSignedIn={res => {
                      if (res.paid) {
                        setPaid(true);
                        setWantWriter(true);
                      }
                    }}
                  />
                ) : (
                  <SoftButton label="Already subscribed? Sign in" icon="lock" onPress={() => setShowSignIn(true)} />
                )}
              </View>
            ) : null}
          </>
        ) : null}
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
    topRow: { flexDirection: 'row', justifyContent: 'flex-end' },
    // 44 dp tall: the one door to the paid half, small but not hard to hit.
    proLink: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(6),
      minHeight: s(44),
      paddingHorizontal: s(12),
    },
    moreRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: s(6),
      minHeight: s(44),
    },
    doneCard: { marginTop: s(18), marginBottom: s(10) },
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
