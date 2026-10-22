import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
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
import { sizeMb, spaceFits, spaceReason, writerBlockedReason } from './deviceFit';
import { entitlement, markPaywallSeen, type Entitlement } from '../billing/trial';
import SignInForm from '../billing/SignInForm';
import { proToFetch } from '../billing/proDownload';
import { runProModels, useProModelsStore } from '../setup/proModels';
import {
  buyWithPlay,
  playAvailable,
  playPlans,
  playPrice,
  referencePrice,
  restorePlayPurchase,
} from '../billing/subscription';
import { trialLength, trialTerms } from '../billing/trialTerms';
import { proHighlights } from '../billing/proHighlights';
import { purchaseNotice } from '../billing/purchaseNotice';
import { explainer, freeHeadline } from '../billing/allowanceCopy';
import type { PlayPlan } from '../native/NativeBilling';
import { radius, s, sv, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Paywall'>;

/**
 * The sell, shown at the moment of value rather than buried in Settings.
 *
 * Pro unlocks one idea — a model that reads the transcript and writes about it — and nobody buys
 * that from a feature list. They buy it after seeing what it wrote about their own meeting, with
 * their own colleagues in it. So this screen is opened once, off the first meeting that finished
 * processing, and it leads with Play's free trial — seven days, then the price, cancellable in Play
 * — because it is the only honest way to answer "is it any good on MY meetings", which is the only
 * question that matters here.
 *
 * Two rules this screen holds itself to:
 *
 *   - Nothing on it is advertised that is not built. The paid half is unlimited meetings of any
 *     length (Free is five a month, up to an hour each), search by meaning, prose
 *     summaries shaped to the kind of meeting, narrated minutes, asking a meeting a question,
 *     remembered voices, threads across meetings, the vocabulary, and the larger transcriber —
 *     each one shipped and run on a phone before its row went in here. There is no roadmap on
 *     this page.
 *   - Nothing free is dressed up as paid. The free tier's floor — record, transcribe, tell the
 *     speakers apart, rule-based minutes, copy to the clipboard — is stated on the page that is
 *     trying to take money, because that is where it is worth something. Exporting a FILE (MP3,
 *     PDF, SRT, Markdown, text) is Pro, by the founder's decision of 13 Oct 2026, and is listed
 *     below like any other paid row; Copy and the preview stay free.
 *   - Nothing is promised to a phone that cannot keep the promise. The rows the writer delivers
 *     say "Not on this phone" — with the memory it needs and has — on a phone under the gate,
 *     before the trial and the price. The rows that need no writer (search, voices, threads, the
 *     vocabulary, the transcriber) stay promised, because the phone can keep them.
 */
const INCLUDED: { icon: IconName; title: string; body: string; needsWriter?: boolean }[] = [
  {
    icon: 'share',
    title: 'Export: MP3, PDF, SRT, Markdown, text',
    body:
      'Send the minutes as a PDF, Markdown, text or subtitles, or the original recording as an ' +
      'MP3. Looking at the preview and copying the write-up to the clipboard stay free.',
  },
  {
    icon: 'inbox',
    title: 'More meetings, any length',
    body:
      'Free is 5 meetings a month, up to 1 hour each. Pro has no monthly limit and no length ' +
      'limit: record as many meetings as you like, and a ninety-minute one in a single go.',
  },
  {
    icon: 'search',
    title: 'Search by meaning',
    body:
      'Search finds every word across your meetings for free. Pro also finds what you meant: ' +
      '"what it will cost" turns up the budget even when nobody said "cost". For when you know ' +
      'it was said and not which meeting it was said in.',
  },
  {
    icon: 'edit',
    title: 'Summaries written, not extracted',
    body:
      'A model on your phone reads the whole transcript and writes what the meeting was about, in ' +
      'sentences — shaped to the kind of meeting it was, a stand-up or a client call or an ' +
      'interview — instead of the highest-scoring lines lifted out of it.',
    needsWriter: true,
  },
  {
    icon: 'list',
    title: 'Minutes that read like minutes',
    body:
      'The same model narrates the decisions and the actions into prose you can send to someone ' +
      'who was not there, with the rule-based list still underneath it.',
    needsWriter: true,
  },
  {
    icon: 'chat',
    title: 'Ask the meeting',
    body:
      'Ask what was agreed about the deadline and get an answer that points at the moment it was ' +
      'said — or tells you plainly that nothing in this meeting settles it.',
    needsWriter: true,
  },
  {
    icon: 'users',
    title: 'Voices it remembers',
    body:
      'Name someone once and the next time their voice is in the room the app asks "Sounds like ' +
      'Priya?" — off until you switch it on, kept on this phone, forgotten in one tap.',
  },
  {
    icon: 'inbox',
    title: 'One thread across meetings',
    body:
      'Meetings that share a tag become a thread: what is still open across all of them, and ' +
      'every decision in the order it was made, with the ones that changed an earlier one marked.',
  },
  {
    icon: 'list',
    title: 'Every action in one list',
    body:
      'The open actions from all your meetings in a single worklist, each one opening the ' +
      'moment it was said.',
  },
  {
    icon: 'sliders',
    title: 'Your words, spelled your way',
    body:
      'Correct a name or a term once — "in over" to "Innova" — and it is written that way in ' +
      'every meeting after.',
  },
  {
    icon: 'ai',
    title: 'The larger transcriber',
    body:
      'A larger model writes down what was said: slower, and noticeably better with strong accents, ' +
      'crosstalk and a bad room.',
  },
];

const FREE_FOREVER =
  'Recording, transcripts, who-said-what, copying the write-up and rule-based minutes stay free — with or ' +
  `without a subscription, before or after a trial. ${freeHeadline} ${explainer}`;

export default function PaywallScreen({ navigation, route }: Props) {
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
  const [busy, setBusy] = useState<'buy' | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // What buying would fetch on THIS phone, quoted under the button.
  const [proMb, setProMb] = useState(0);
  // Pro's background download (src/setup/proModels): its progress and why it stopped.
  const pro = useProModelsStore();
  // The sentence for a phone under the writer's gate — null when it runs here. From the rows.
  const [writerBlocked, setWriterBlocked] = useState<string | null>(null);
  // The disk sentence for the trial's download — null when it fits, or when nothing is pending.
  const [spaceShort, setSpaceShort] = useState<string | null>(null);
  // The trial's download progress shows in the pinned dock; the scroll goes back to the top so the
  // highlights and the headline ("You are on Pro") are what the buyer sees next to it.
  const scroller = useRef<ScrollView>(null);

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
        const all: {
          id: string;
          kind: string;
          sizeBytes: number;
          installed: boolean;
          needsSubscription: boolean;
          unsupportedReason?: string | null;
        }[] = JSON.parse(r);
        setWriterBlocked(writerBlockedReason(all));
        const todo = proToFetch(all);
        setProMb(sizeMb(todo));
        const pendingBytes = todo.reduce((a, m) => a + m.sizeBytes, 0);
        if (pendingBytes > 0) {
          ModelManager.deviceFit()
            .then(r => {
              const fit: { freeBytes: number } = JSON.parse(r);
              setSpaceShort(spaceFits(pendingBytes, fit.freeBytes) ? null : spaceReason("Pro's models", pendingBytes, fit.freeBytes));
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  const onBuy = useCallback(async () => {
    setBusy('buy');
    try {
      const plan = plans.find(p => p.basePlanId === chosenPlan) ?? null;
      const result = await buyWithPlay(chosenPlan);
      // Paid but not yet confirmed, or still authorising: said as what it is, never as a failure.
      const notice = purchaseNotice(result);
      if (notice) {
        Alert.alert(notice.title, notice.body);
        return;
      }
      if (result.paid) {
        await load();
        // From first run: straight back to setup, whose Download button fetches the writer along
        // with everything else. A second download started here would race it.
        if (route.params?.from === 'onboarding') {
          navigation.goBack();
          return;
        }
        const free = plan ? trialLength(plan) : null;
        Alert.alert(
          free ? 'Your free trial has started' : 'You are on Pro',
          free
            ? `Pro is on, free for ${free}. Cancel in Google Play before then and you pay nothing. ` +
              "Pro's models are downloading now. The download carries on in the background while you use the app."
            : "Pro's models are downloading now. The download carries on in the background while you use the app.",
        );
      }
      // Not paid means the buyer backed out or the payment is still authorising. Neither is a
      // failure, and neither earns a dialog.
    } catch (e: any) {
      Alert.alert('Could not complete the purchase', String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [chosenPlan, plans, load, navigation, route.params]);

  const onRestore = useCallback(async () => {
    setRestoring(true);
    try {
      const result = await restorePlayPurchase();
      const notice = purchaseNotice(result);
      if (notice) {
        Alert.alert(notice.title, notice.body);
      } else if (result.paid) {
        await load();
        Alert.alert('Subscription restored', 'Pro is back on this phone.');
      } else {
        Alert.alert('Nothing to restore', 'This Google account has no active Verbale subscription.');
      }
    } catch (e: any) {
      Alert.alert('Could not restore', String(e?.message ?? e));
    } finally {
      setRestoring(false);
    }
  }, [load]);

  const bought = Boolean(ent?.licence?.paid);

  // Bought: start Pro's download at once, straight after a purchase, a restore or a sign-in, and
  // pick up one that stopped whenever this screen opens on Pro. runProModels does nothing when
  // everything is already here, and joins a run already going. First run is the exception:
  // setup's own download fetches Pro's models there, and two runs would race.
  useEffect(() => {
    if (bought && route.params?.from !== 'onboarding') runProModels().catch(() => {});
  }, [bought, route.params]);
  const chosen = plans.find(p => p.basePlanId === chosenPlan) ?? null;
  // Play shows its trial only to an account that has never subscribed, so its presence on the
  // chosen plan is the whole eligibility check.
  const chosenFree = chosen ? trialLength(chosen) : null;
  const terms = chosen ? trialTerms(chosen) : null;

  /** The one line under the title, which is the only line most people will read. */
  const headline = bought
    ? 'You are on Pro. Everything below is already on.'
    : 'Everything Free does, without the limits.';

  // With no trial to lead with, the button carries the price and how often it is charged, so the
  // one thing a buyer reads before Play's sheet is the whole cost.
  const per = chosen?.period === 'P1Y' ? ' a year' : chosen?.period === 'P1M' ? ' a month' : '';
  const priceLabel = chosenFree
    ? `Try it free for ${chosenFree}`
    : playCost
      ? `Subscribe — ${playCost}${per}`
      : 'Subscribe';

  const highlights = proHighlights(route.params?.from, writerBlocked === null);

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="x" label="Close" onPress={() => navigation.goBack()} />
      </View>

      <ScrollView
        ref={scroller}
        style={st.flex}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={st.body}>
        <Pop style={st.hero}>
          <Mascot mood={bought ? 'happy' : 'idle'} size={sv(56)} />
          <View style={st.flex}>
            <Txt variant="display">Verbale Pro</Txt>
            <Txt variant="sub" color={colors.inkSoft}>
              {headline}
            </Txt>
          </View>
        </Pop>

        {/* The pitch for somebody who reads nothing else: three lines, all above the fold. */}
        <Pop index={1} style={st.highlights}>
          {highlights.map(h => (
            <View key={h.key} style={st.highlight} testID={`highlight-${h.key}`}>
              <View style={[st.highlightIcon, { backgroundColor: colors.primarySoft }]}>
                <Icon name={h.icon} size={s(18)} color={colors.primary} strokeWidth={2.4} />
              </View>
              <Txt variant="bodyBlack" style={st.flex}>
                {h.text}
              </Txt>
            </View>
          ))}
        </Pop>

        <Txt variant="overlineSm" color={colors.inkFaint} style={st.allTitle}>
          EVERYTHING IN PRO
        </Txt>
        <View style={st.list}>
          {INCLUDED.map((f, i) => {
            const off = f.needsWriter === true && writerBlocked !== null;
            return (
              <Pop key={f.title} index={i + 2}>
                <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
                  <View style={st.feature}>
                    <View style={[st.featureIcon, { backgroundColor: off ? colors.warningSoft : colors.primarySoft }]}>
                      <Icon name={f.icon} size={s(20)} color={off ? colors.warning : colors.primary} strokeWidth={2.4} />
                    </View>
                    <View style={st.flex}>
                      <Txt variant="cardTitleSm">{f.title}</Txt>
                      <Txt variant="chip" color={colors.inkSoft} style={st.featureBody}>
                        {f.body}
                      </Txt>
                      {off ? (
                        <Txt variant="chip" color={colors.warning} style={st.featureBody}>
                          Not on this phone. {writerBlocked}
                        </Txt>
                      ) : null}
                    </View>
                  </View>
                </Raised>
              </Pop>
            );
          })}
        </View>

        {/* Said on the paywall, where it costs something to say. A free tier stated only in
            marketing copy is a claim; stated here it is a commitment. */}
        <Pop index={INCLUDED.length + 2} style={st.floorWrap}>
          <View style={[st.floor, { backgroundColor: colors.successSoft }]}>
            <Icon name="shield" size={s(20)} color={colors.success} strokeWidth={2.4} />
            <Txt variant="chip" color={colors.ink} style={st.flex}>
              {FREE_FOREVER}
            </Txt>
          </View>
        </Pop>

        {/* Restore and sign-in are for the few who already paid. They stay findable, below the
            list, and out of the pinned dock, which is for people deciding. */}
        {!bought ? (
          <View style={st.after}>
            {playCan && !bought ? (
              <SoftButton
                icon="download"
                label={restoring ? 'Checking…' : 'Restore purchase'}
                onPress={onRestore}
                disabled={busy !== null || restoring}
              />
            ) : null}

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
                  <SignInForm onSignedIn={res => { if (res.paid) load(); }} />
                ) : (
                  <SoftButton
                    icon="lock"
                    label="Subscribed on the web? Sign in"
                    onPress={() => setShowSignIn(true)}
                  />
                )}
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      {/* Pinned: the plan, the button and the terms never scroll away. Play's policy wants the
          price and the trial terms beside the offer, and a buyer should not have to hunt for it. */}
      <View
        style={[
          st.dock,
          { backgroundColor: colors.card, borderTopColor: colors.line, paddingBottom: insets.bottom + s(12) },
        ]}>
        {pro.running && pro.total > 0 ? (
          <View style={st.dl}>
            <Txt variant="chip" color={colors.inkSoft}>
              Downloading Pro's models — {downloadLabel(pro.downloaded, pro.total)}
            </Txt>
            <ProgressBar pct={downloadPct(pro.downloaded, pro.total)} color={colors.primary} track={colors.cardAlt} />
            <Txt variant="chip" color={colors.inkFaint}>
              You can leave this screen. The download carries on in the background while you use the app.
            </Txt>
          </View>
        ) : null}
        {pro.error ? (
          <View style={st.dl}>
            <Txt variant="chip" color={colors.warning}>
              {`Pro's models did not finish downloading: ${pro.error}`}
            </Txt>
            <Button label="Try again" icon="download" onPress={() => runProModels().catch(() => {})} full />
          </View>
        ) : null}
        {bought ? (
          <SoftButton icon="check" label="Close" onPress={() => navigation.goBack()} />
        ) : playCan ? (
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
                      {trialLength(pl) ? (
                        <Txt variant="chip" color={colors.primary}>
                          {trialLength(pl)} free
                        </Txt>
                      ) : null}
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
            <Button
              label={busy === 'buy' ? 'One moment…' : priceLabel}
              icon="check"
              onPress={onBuy}
              disabled={busy !== null}
              full
            />
            {terms ? (
              <Txt variant="chip" color={colors.inkFaint} style={st.note}>
                {terms}
              </Txt>
            ) : null}
            {!bought ? (
              <Txt variant="chip" color={colors.inkFaint} style={st.note}>
                {chosenFree
                  ? "Payments aren't refundable — the free week is for trying it."
                  : "Payments aren't refundable."}
              </Txt>
            ) : null}
            {!bought && proMb > 0 ? (
              <Txt variant="chip" color={colors.inkFaint} style={st.note}>
                {`Pro downloads ${proMb} MB of models as soon as you start, so start on wifi.`}
              </Txt>
            ) : null}
            {spaceShort ? (
              <Txt variant="chip" color={colors.warning} style={st.note}>
                {spaceShort}
              </Txt>
            ) : null}
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
            This install cannot buy through the Play Store. If you already subscribed elsewhere, use
            "Subscribed on the web? Sign in" above and it will be picked up here.
          </Txt>
        )}
      </View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: s(20) },
    body: { paddingHorizontal: s(20), paddingTop: s(4), paddingBottom: s(24) },
    hero: { flexDirection: 'row', alignItems: 'center', gap: s(14) },
    highlights: { marginTop: s(18), gap: s(12) },
    highlight: { flexDirection: 'row', alignItems: 'center', gap: s(12) },
    highlightIcon: {
      width: s(36),
      height: s(36),
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    allTitle: { marginTop: s(26) },
    list: { gap: s(10), marginTop: s(10) },
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
    dl: { gap: s(8) },
    after: { marginTop: s(20), gap: s(10) },
    dock: {
      paddingHorizontal: s(20),
      paddingTop: s(12),
      gap: s(8),
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    plans: {
      flexDirection: 'row',
      gap: s(8),
      marginBottom: s(10),
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
    note: { marginTop: s(2) },
    signIn: { marginTop: s(8) },
  });
}
