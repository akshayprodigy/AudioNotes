import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  NativeEventEmitter,
  NativeModules,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import ModelManager from '../native/NativeModelManager';
import Icon, { type IconName } from '../components/Icon';
import Mascot from '../components/Mascot';
import { Button, IconButton, Pop, ProgressBar, Raised, SoftButton, Txt } from '../components/ui';
import { downloadLabel, downloadPct } from './downloadLabel';
import {
  TRIAL_DAYS,
  TRIAL_SUMMARIES,
  entitlement,
  markPaywallSeen,
  startTrial,
  type Entitlement,
} from '../billing/trial';
import SignInForm from '../billing/SignInForm';
import {
  buyWithPlay,
  playAvailable,
  playPlans,
  playPrice,
  referencePrice,
} from '../billing/subscription';
import type { PlayPlan } from '../native/NativeBilling';
import { radius, s, sv, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Paywall'>;

/**
 * The sell, shown at the moment of value rather than buried in Settings.
 *
 * Pro unlocks one idea — a model that reads the transcript and writes about it — and nobody buys
 * that from a feature list. They buy it after seeing what it wrote about their own meeting, with
 * their own colleagues in it. So this screen is opened once, off the first meeting that finished
 * processing, and it offers the trial before it offers the price: seven days and three summaries
 * is a cheaper thing to ask for than a card, and it is the only honest way to answer "is it any
 * good on MY meetings", which is the only question that matters here.
 *
 * Two rules this screen holds itself to:
 *
 *   - Nothing on it is advertised that is not built. The paid half is prose summaries, narrated
 *     minutes, and the larger transcriber. There is no roadmap on this page.
 *   - Nothing free is dressed up as paid. The free tier's floor — record, transcribe, tell the
 *     speakers apart, rule-based minutes, export — is stated on the page that is trying to take
 *     money, because that is where it is worth something. Export stays free deliberately: the
 *     document a free user forwards to five colleagues is the acquisition loop, and charging for
 *     it would be charging for our own marketing.
 */
const INCLUDED: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'search',
    title: 'Search everything you have recorded',
    body:
      'Every word of every transcript, searchable across all your meetings — for when you know it ' +
      'was said and not which meeting it was said in.',
  },
  {
    icon: 'edit',
    title: 'Summaries written, not extracted',
    body:
      'A model on your phone reads the whole transcript and writes what the meeting was about, in ' +
      'sentences — instead of the highest-scoring lines lifted out of it.',
  },
  {
    icon: 'list',
    title: 'Minutes that read like minutes',
    body:
      'The same model narrates the decisions and the actions into prose you can send to someone ' +
      'who was not there, with the rule-based list still underneath it.',
  },
  {
    icon: 'ai',
    title: 'The larger transcriber',
    body:
      'Whisper small instead of base: slower, and noticeably better with strong accents, ' +
      'crosstalk and a bad room.',
  },
];

const FREE_FOREVER =
  'Recording, transcripts, who-said-what, export and rule-based minutes stay free — with or ' +
  'without a subscription, before or after a trial. Free meetings run up to 15 minutes.';

export default function PaywallScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  const [ent, setEnt] = useState<Entitlement | null>(null);
  const [playCan, setPlayCan] = useState(false);
  const [playCost, setPlayCost] = useState<string | null>(null);
  // Every base plan Play offers, and which one is selected. Annual is preselected when it exists:
  // it is the better deal for the buyer as well as for us, and the saving is stated rather than
  // implied. Selection is by basePlanId — never by position, since ordering is Play's to choose.
  const [plans, setPlans] = useState<PlayPlan[]>([]);
  const [chosenPlan, setChosenPlan] = useState<string | null>(null);
  // Whether the price simply has not arrived yet. Distinct from "Play answered and had none":
  // a spinner-shaped silence and a genuine failure deserve different sentences.
  const [priceAsked, setPriceAsked] = useState(false);
  const [busy, setBusy] = useState<'trial' | 'buy' | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);

  // The writer model, which is what a trial actually needs on disk. A trial that grants an
  // entitlement to run a model the phone does not have is a trial of nothing.
  const [writerMb, setWriterMb] = useState(0);
  const [writerInstalled, setWriterInstalled] = useState(false);
  // Bytes, not a percentage. See downloadLabel: on a 1.1 GB model the percentage barely
  // moves, and a still number reads as a stalled download.
  const [dl, setDl] = useState<{ downloaded: number; total: number } | null>(null);

  const load = useCallback(async () => {
    setEnt(await entitlement());
  }, []);

  useEffect(() => {
    load();
    // Recorded on open, not on purchase. The point of the stamp is that this offer was MADE; a
    // second showing to somebody who declined is a nag, and the whole pitch of this app is that
    // it does not behave that way.
    markPaywallSeen().catch(() => {});
  }, [load]);

  useEffect(() => {
    playAvailable()
      .then(async can => {
        setPlayCan(can);
        if (!can) return;
        const list = await playPlans();
        setPlans(list);
        if (list.length > 0) {
          const annual = list.find(pl => pl.period === 'P1Y');
          const pick = annual ?? list[0];
          setChosenPlan(pick.basePlanId);
          setPlayCost(pick.price);
        } else {
          // Older builds, or a Play answer we could not read as a plan list.
          setPlayCost(await playPrice());
        }
      })
      .finally(() => setPriceAsked(true));
  }, []);

  useEffect(() => {
    ModelManager.list()
      .then(r => {
        const all: { id: string; kind: string; sizeBytes: number; installed: boolean }[] =
          JSON.parse(r);
        const writer = all.filter(m => m.kind === 'llm');
        setWriterMb(Math.round(writer.reduce((a, m) => a + m.sizeBytes, 0) / 1e6));
        setWriterInstalled(writer.length > 0 && writer.every(m => m.installed));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.ModelManager);
    const sub = emitter.addListener('onModelProgress', (e: { total: number; downloaded: number }) => {
      if (e.total > 0) setDl({ downloaded: e.downloaded, total: e.total });
    });
    return () => sub.remove();
  }, []);

  /**
   * Start the trial, then fetch the model it is a trial of.
   *
   * The download is deliberately not silent and not in the background: it is over a gigabyte, and
   * a person who taps "start my trial" and watches nothing happen for ten minutes on hotel wifi
   * has been lied to. The trial clock starts first regardless, because a download that fails and
   * is retried tomorrow must not be able to restart the window.
   */
  const onStartTrial = useCallback(async () => {
    setBusy('trial');
    try {
      await startTrial();
      await load();
      const list: { id: string; kind: string; installed: boolean }[] = JSON.parse(
        await ModelManager.list(),
      );
      const missing = list.filter(m => m.kind === 'llm' && !m.installed);
      for (const m of missing) {
        setDl({ downloaded: 0, total: 0 });
        await ModelManager.download(m.id);
      }
      setWriterInstalled(true);
    } catch (e: any) {
      // Most likely cause today: the native download gate still asks for a paid licence and does
      // not yet know about trials. Say what happened rather than leaving a dead progress bar.
      Alert.alert(
        'The writer could not be downloaded',
        `${String(e?.message ?? e)}\n\nYour trial has started and nothing has been spent. You can ` +
          'fetch the model from Settings once you are on a better connection.',
      );
    } finally {
      setDl(null);
      setBusy(null);
    }
  }, [load]);

  const onBuy = useCallback(async () => {
    setBusy('buy');
    try {
      const result = await buyWithPlay(chosenPlan);
      if (result.paid) {
        await load();
        Alert.alert('You are on Pro', 'The written summary and the narrated minutes are on.');
      }
      // Not paid means the buyer backed out or the payment is still authorising. Neither is a
      // failure, and neither earns a dialog.
    } catch (e: any) {
      Alert.alert('Could not complete the purchase', String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [chosenPlan, load]);

  const trial = ent?.trial;
  const bought = Boolean(ent?.licence?.paid);

  /** The one line under the title, which is the only line most people will read. */
  const headline = (() => {
    if (bought) return 'You are on Pro. Everything below is already on.';
    if (trial?.status === 'active') {
      const days = trial.daysLeft === 1 ? '1 day' : `${trial.daysLeft} days`;
      const left = trial.summariesLeft === 1 ? '1 summary' : `${trial.summariesLeft} summaries`;
      return `Your trial is running: ${days} and ${left} left, whichever goes first.`;
    }
    if (trial?.status === 'ended') {
      return trial.endedBecause === 'summaries'
        ? `That was the ${TRIAL_SUMMARIES} trial summaries. Everything they wrote is still in your library.`
        : 'Your trial has ended. Everything it wrote is still in your library.';
    }
    return 'Let the phone write your minutes for you, in sentences, before you decide.';
  })();

  const priceLabel = playCost ? `Subscribe — ${playCost}` : 'Subscribe';

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="x" label="Close" onPress={() => navigation.goBack()} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[st.body, { paddingBottom: insets.bottom + s(28) }]}>
        <View style={st.hero}>
          <Pop>
            <Mascot mood={bought || trial?.status === 'active' ? 'happy' : 'idle'} size={sv(112)} />
          </Pop>
          <Pop index={1} style={st.heroText}>
            <Txt variant="display" style={st.centerText}>
              Verbale Pro
            </Txt>
            <Txt variant="body" color={colors.inkSoft} style={[st.centerText, st.heroSub]}>
              {headline}
            </Txt>
          </Pop>
        </View>

        <View style={st.list}>
          {INCLUDED.map((f, i) => (
            <Pop key={f.title} index={i + 2}>
              <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
                <View style={st.feature}>
                  <View style={[st.featureIcon, { backgroundColor: colors.primarySoft }]}>
                    <Icon name={f.icon} size={s(20)} color={colors.primary} strokeWidth={2.4} />
                  </View>
                  <View style={st.flex}>
                    <Txt variant="cardTitleSm">{f.title}</Txt>
                    <Txt variant="chip" color={colors.inkSoft} style={st.featureBody}>
                      {f.body}
                    </Txt>
                  </View>
                </View>
              </Raised>
            </Pop>
          ))}
        </View>

        {/* Said on the paywall, where it costs something to say. A free tier stated only in
            marketing copy is a claim; stated here it is a commitment. */}
        <Pop index={5} style={st.floorWrap}>
          <View style={[st.floor, { backgroundColor: colors.successSoft }]}>
            <Icon name="shield" size={s(20)} color={colors.success} strokeWidth={2.4} />
            <Txt variant="chip" color={colors.ink} style={st.flex}>
              {FREE_FOREVER}
            </Txt>
          </View>
        </Pop>

        {dl !== null ? (
          <View style={st.dl}>
            <Txt variant="chip" color={colors.inkSoft}>
              Downloading the writer — {downloadLabel(dl.downloaded, dl.total)}
            </Txt>
            <ProgressBar pct={downloadPct(dl.downloaded, dl.total)} color={colors.primary} track={colors.cardAlt} />
          </View>
        ) : null}

        <View style={st.cta}>
          {bought ? (
            <SoftButton icon="check" label="Close" onPress={() => navigation.goBack()} />
          ) : (
            <>
              {trial?.status === 'unstarted' ? (
                <>
                  <Button
                    label={busy === 'trial' ? 'Starting…' : `Try Pro free for ${TRIAL_DAYS} days`}
                    icon="ai"
                    onPress={onStartTrial}
                    disabled={busy !== null}
                    full
                  />
                  {/* Both limits, and the download, before the tap rather than after it. */}
                  <Txt variant="chip" color={colors.inkFaint} style={st.note}>
                    {TRIAL_DAYS} days or {TRIAL_SUMMARIES} written summaries, whichever runs out
                    first. No card, nothing to cancel
                    {writerInstalled || writerMb === 0
                      ? '.'
                      : ` — but it downloads a ${writerMb} MB model first, so start it on wifi.`}
                  </Txt>
                </>
              ) : null}

              {playCan ? (
                <>
                  {plans.length > 1 ? (
                    <View style={st.plans}>
                      {plans.map(pl => {
                        const ref = referencePrice(pl, plans);
                        const on = pl.basePlanId === chosenPlan;
                        return (
                          <Pressable
                            key={pl.basePlanId}
                            accessibilityRole="radio"
                            accessibilityState={{ selected: on }}
                            accessibilityLabel={
                              `${pl.period === 'P1Y' ? 'Yearly' : 'Monthly'}, ${pl.price ?? ''}` +
                              (ref ? `, was ${ref.was}, saving ${ref.savedPercent} percent` : '')
                            }
                            onPress={() => {
                              setChosenPlan(pl.basePlanId);
                              setPlayCost(pl.price);
                            }}
                            style={[st.plan, on && st.planOn]}>
                            <Txt variant="chip" color={on ? colors.ink : colors.inkFaint}>
                              {pl.period === 'P1Y' ? 'Yearly' : 'Monthly'}
                            </Txt>
                            <Txt variant="body" color={colors.ink}>
                              {pl.price ?? '—'}
                            </Txt>
                            {/* Struck through ONLY from referencePrice, which draws on Play's own
                                full price or on twelve times the monthly rate. Never a constant:
                                a "was" nobody was charged is a fabricated anchor. */}
                            {ref ? (
                              <Txt variant="chip" color={colors.inkFaint}>
                                <Txt variant="chip" color={colors.inkFaint} style={st.wasPrice}>
                                  {ref.was}
                                </Txt>
                                {ref.savedPercent > 0 ? `  save ${ref.savedPercent}%` : ''}
                              </Txt>
                            ) : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}
                  <View style={trial?.status === 'unstarted' ? st.secondary : undefined}>
                    {trial?.status === 'unstarted' ? (
                      <SoftButton
                        icon="check"
                        label={busy === 'buy' ? 'One moment…' : priceLabel}
                        onPress={onBuy}
                        disabled={busy !== null}
                      />
                    ) : (
                      <Button
                        label={busy === 'buy' ? 'One moment…' : priceLabel}
                        icon="check"
                        onPress={onBuy}
                        disabled={busy !== null}
                        full
                      />
                    )}
                  </View>
                  {/* A blank where a price should be is the thing people distrust most on a paid
                      screen, so the absence is explained instead of hidden. */}
                  {!playCost && priceAsked ? (
                    <Txt variant="chip" color={colors.inkFaint} style={st.note}>
                      The Play Store has not sent the price yet — you will see it, and be able to
                      change your mind, before anything is charged.
                    </Txt>
                  ) : null}
                </>
              ) : (
                <Txt variant="chip" color={colors.inkFaint} style={st.note}>
                  This install cannot buy through the Play Store. If you already subscribed
                  elsewhere, sign in below and it will be picked up here.
                </Txt>
              )}

              {/*
                The way in for somebody who already paid — on the website, or on a phone they no
                longer have. Until this existed, the one screen in the app that explains Pro gave
                them nothing to do about it but go hunting through Settings, which is exactly where
                the product review said the purchase had been hiding all along.

                Collapsed by default: this screen is for people deciding, and a login form at the
                top of it reads as a wall. It only has to be findable by the minority who need it.
              */}
              {!ent?.licence?.paid ? (
                <View style={st.signIn}>
                  {showSignIn ? (
                    <SignInForm onSignedIn={res => { if (res.paid) navigation.goBack(); }} />
                  ) : (
                    <SoftButton
                      icon="lock"
                      label="Already subscribed? Sign in"
                      onPress={() => setShowSignIn(true)}
                    />
                  )}
                </View>
              ) : null}

              {trial?.status === 'ended' ? (
                <Txt variant="chip" color={colors.inkFaint} style={st.note}>
                  Nothing was taken away when the trial ended: every summary and every set of
                  minutes it wrote is still in your library, and always will be.
                </Txt>
              ) : null}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: s(20) },
    body: { paddingHorizontal: s(20), paddingTop: s(4) },
    hero: { alignItems: 'center', gap: s(6) },
    // Stretched rather than centred, for the same reason onboarding's hero is: a shrink-to-fit
    // block gets measured at one width and laid out at another, and the subtitle clips.
    heroText: { alignSelf: 'stretch' },
    heroSub: { marginTop: s(6) },
    centerText: { textAlign: 'center' },
    list: { gap: s(10), marginTop: s(20) },
    feature: { flexDirection: 'row', alignItems: 'flex-start', gap: s(14), padding: s(16) },
    featureIcon: {
      width: s(44),
      height: s(44),
      borderRadius: radius.lg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    featureBody: { marginTop: s(3) },
    floorWrap: { marginTop: s(14) },
    floor: {
      flexDirection: 'row',
      gap: s(12),
      alignItems: 'center',
      borderRadius: radius.xl,
      padding: s(16),
    },
    dl: { marginTop: s(16), gap: s(8) },
    cta: { marginTop: s(20), gap: s(10) },
    plans: {
    flexDirection: 'row',
    gap: s(8),
    marginBottom: s(12),
  },
  plan: {
    flex: 1,
    alignItems: 'center',
    gap: s(2),
    paddingVertical: s(10),
    paddingHorizontal: s(8),
    borderRadius: s(12),
    borderWidth: 1,
    borderColor: c.line,
  },
  planOn: {
    borderColor: c.ink,
    borderWidth: 2,
  },
  wasPrice: {
    textDecorationLine: 'line-through',
  },
  secondary: { flexDirection: 'row' },
    note: { marginTop: s(2) },
    signIn: { marginTop: s(18) },
  });
}
