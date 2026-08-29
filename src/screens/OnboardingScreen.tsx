import React, { useEffect, useMemo, useState } from 'react';
import { NativeEventEmitter, NativeModules, StyleSheet, View } from 'react-native';
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
    title: 'Record any meeting',
    body: 'Keeps listening with the screen off or while you use other apps.',
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
  const [writer, setWriter] = useState<Essential[]>([]);
  // Whether the writer model may be fetched at all. ModelManager.download refuses it without a
  // subscription — that refusal is the enforcement — so offering the switch to someone who has
  // not subscribed would be offering a button that cannot work.
  //
  // On a first run this is always false, which makes the opening download 114 MB instead of
  // 1.2 GB. That is a better first impression than the one it replaces, not a worse one.
  const [paid, setPaid] = useState(false);
  const [wantWriter, setWantWriter] = useState(false);

  useEffect(() => {
    Licence.status()
      .then(st => {
        setPaid(st.paid);
        // Defaulted on for a subscriber: a meeting app whose minutes read like a word count is
        // not the product, and this model is what turns a transcript into something anyone will
        // actually read. Off is one tap away.
        setWantWriter(st.paid);
      })
      .catch(() => {});
    ModelManager.list()
      .then(r => {
        const all: Essential[] = JSON.parse(r);
        setEssentials(all.filter(m => m.required));
        setWriter(all.filter(m => !m.required && m.kind === 'llm'));
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
  const chosen = paid && wantWriter ? [...essentials, ...writer] : essentials;
  const totalMb = Math.round(chosen.reduce((a, m) => a + m.sizeBytes, 0) / 1e6);
  const writerMb = Math.round(writer.reduce((a, m) => a + m.sizeBytes, 0) / 1e6);

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
    setStatus('downloading');
    AudioPipeline.requestBatteryExemption().catch(() => {});
    for (let i = 0; i < chosen.length; i++) {
      setStep(i);
      setCurrent(chosen[i].purpose);
      setPct(0);
      try {
        await ModelManager.download(chosen[i].id);
      } catch {
        // Only a REQUIRED model can fail the setup. Losing the writer means minutes pulled out by
        // rule instead of written as prose — a smaller app, not a broken one — and it can be
        // fetched later from Settings. Failing the whole first run over it would be a lie about
        // how badly things went.
        if (chosen[i].required) {
          setStatus('failed');
          return;
        }
      }
    }
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
              {step + 1} of {essentials.length}
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
    <View style={[st.root, pad]}>
      <View style={st.hero}>
        <Pop>
          <Mascot mood="idle" size={sv(132)} />
        </Pop>
        <Pop index={1}>
          <Txt variant="screenTitle" style={st.centerText}>
            AudioNotes
          </Txt>
          <Txt variant="label" color={colors.inkDim} style={st.centerText}>
            Your private meeting note-taker
          </Txt>
        </Pop>
      </View>

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
                  {paid
                    ? `Adds ${writerMb} MB. Without it you still get minutes, pulled out by rule rather than written as prose.`
                    : `Part of the subscription — a ${writerMb} MB model that runs on your phone. You still get minutes without it, pulled out by rule rather than written as prose.`}
                </Txt>
              </View>
              {/* No switch when there is nothing to switch on. A control that reports a
                  subscription error on tap is worse than an honest sentence. */}
              {paid ? <Switch on={wantWriter} onToggle={() => setWantWriter(v => !v)} /> : null}
            </View>
          </Raised>
        ) : null}
        <Button
          label={totalMb > 0 ? `Download the AI (${totalMb} MB)` : 'Download the AI'}
          icon="download"
          onPress={downloadAll}
          disabled={chosen.length === 0}
          full
        />
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
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas, paddingHorizontal: s(22) },
    flex: { flex: 1 },
    center: { alignItems: 'center', justifyContent: 'center' },
    centerText: { textAlign: 'center' },
    hero: { alignItems: 'center', paddingTop: s(10), gap: s(6) },
    list: { flex: 1, justifyContent: 'center', gap: s(12), marginTop: s(18) },
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
