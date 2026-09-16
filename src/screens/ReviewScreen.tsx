import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import type { Edit, Item, Meeting, Speaker, Utterance } from '../pipeline/types';
import { db } from '../db/queries';
import { REASON_TEXT, reviewReason, type ReviewReason } from '../pipeline/reviewRule';
import { dayLabel } from '../pipeline/dateNorm';
import Icon, { type IconName } from '../components/Icon';
import { IconButton, Raised, Sheet, TextPrompt, Txt, type SheetAction } from '../components/ui';
import { ProvenanceButton } from './meeting/ItemProvenance';
import SpeakerPicker from './meeting/SpeakerPicker';
import { labelsFor } from './meeting/recordLabels';
import { composeAction, editedText, sentenceCase, splitAction, toEditMap } from './meeting/shared';
import { usePlayer } from './meeting/usePlayer';
import { radius, s, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Review'>;

/** How many days the "which day" sheet offers, the meeting's own day first. */
const DAY_CHOICES = 14;
/** The classifier's reply window (ItemClassifier.REPLY_WINDOW_MS): where the answering turn is. */
const REPLY_WINDOW_MS = 90_000;

/** Six, not the grammar's seven: a person fixing the kind is never "not sure". */
const TYPE_CHOICES: { key: string; label: string }[] = [
  { key: 'commitment', label: 'A commitment' },
  { key: 'request', label: 'A request' },
  { key: 'proposal', label: 'A proposal' },
  { key: 'agreement', label: 'An agreement' },
  { key: 'rejection', label: 'A rejection' },
  { key: 'unresolved', label: 'Left unresolved' },
];

/** The kind of owner the record names, for the review rule. */
function ownerKindOf(ownerJson: string | null): string {
  try {
    return ownerJson ? (JSON.parse(ownerJson).kind as string) ?? 'unassigned' : 'unassigned';
  } catch {
    return 'unassigned';
  }
}

function ownerLabel(ownerJson: string | null, speakers: Speaker[]): string {
  try {
    const o = ownerJson ? JSON.parse(ownerJson) : null;
    if (!o || o.kind === 'unassigned') return 'No owner';
    if (o.kind === 'speaker') return speakers.find(x => x.id === o.id)?.displayName ?? 'A speaker';
    return String(o.name ?? 'Someone');
  } catch {
    return 'No owner';
  }
}

/** The meeting's calendar day in the phone's zone, as UTC midnight — the shape date_norm holds. */
function meetingDayUtc(createdAt: number): number {
  const d = new Date(createdAt);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * The review queue: what the classifier could not settle, one card at a time. Confirm keeps it,
 * Fix edits the one thing the reason names (owner, day, or kind), Not an item rejects it. A fix
 * confirms. Finishing the last card returns to the meeting; leaving early keeps what was done.
 *
 * Only classified items are here — the queue is a Pro surface by construction, not by a gate.
 */
export default function ReviewScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { meetingId } = route.params;
  const player = usePlayer(meetingId);

  const [queue, setQueue] = useState<Item[]>([]);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [at, setAt] = useState(0);
  const [fixing, setFixing] = useState<'menu' | 'owner' | 'date' | 'type' | null>(null);
  const [naming, setNaming] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      db.items(meetingId), db.utterances(meetingId), db.speakers(meetingId), db.getMeeting(meetingId),
      db.edits(meetingId).catch(() => [] as Edit[]),
    ])
      .then(([items, utts, spks, mtg, eds]) => {
        if (!alive) return;
        setQueue(items.filter(i => i.review === 'needs_review' && i.itemType !== null));
        setUtterances(utts);
        setSpeakers(spks);
        setMeeting(mtg ?? null);
        setEdits(eds);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [meetingId]);

  const card = queue[at];

  const reason: ReviewReason | null = useMemo(
    () =>
      card
        ? reviewReason({
            kind: card.kind, type: card.itemType, status: card.status, confidence: null,
            ownerKind: ownerKindOf(card.ownerJson), dateSaid: card.dateSaid, dateNorm: card.dateNorm,
            currentReview: card.review,
          })
        : null,
    [card],
  );

  /**
   * The turn that answered: the first line after the source, inside the classifier's window. The
   * record does not keep which ordinal it cited, so this is the window's first reply — the one a
   * qualification or contradiction almost always is.
   */
  const reply = useMemo(() => {
    if (!card) return null;
    const sourceIds = new Set(card.sources.map(x => x.utteranceId));
    const source = utterances.find(u => sourceIds.has(u.id));
    const from = source?.startMs ?? card.anchorStartMs;
    if (from === null || from === undefined) return null;
    return (
      utterances.find(u => !sourceIds.has(u.id) && u.startMs > from && u.startMs - from <= REPLY_WINDOW_MS) ?? null
    );
  }, [card, utterances]);

  const advance = useCallback(() => {
    setFixing(null);
    if (at + 1 >= queue.length) navigation.goBack();
    else setAt(at + 1);
  }, [at, queue.length, navigation]);

  const confirm = useCallback(async () => {
    if (!card) return;
    await db.setItemReview(card.id, 'confirmed').catch(() => {});
    advance();
  }, [card, advance]);

  const reject = useCallback(async () => {
    if (!card) return;
    await db.setItemReview(card.id, 'rejected').catch(() => {});
    advance();
  }, [card, advance]);

  /**
   * The person's owner, written twice on purpose: `owner_json` is the record, and a correction
   * of the text is what every tab and every export already read the owner from — one write
   * through the edits table reaches all of them, and a Revert there puts the rule's words back.
   * The day and the kind never touch the text: the spoken phrase stays as said.
   */
  const setOwner = useCallback(
    async (ownerJson: string, name: string) => {
      if (!card) return;
      const current = editedText(toEditMap(edits), 'item', card.id, card.text) ?? card.text;
      const { text, due } = splitAction(current);
      await db.setItemOwner(card.id, ownerJson).catch(() => {});
      await db.putEdit(meetingId, 'item', card.id, composeAction(text, name, due ?? undefined)).catch(() => {});
      advance();
    },
    [card, edits, meetingId, advance],
  );

  const setDay = useCallback(
    async (ms: number | null) => {
      if (!card) return;
      await db.setItemDate(card.id, ms).catch(() => {});
      advance();
    },
    [card, advance],
  );

  const setType = useCallback(
    async (itemType: string) => {
      if (!card) return;
      await db.setItemType(card.id, itemType).catch(() => {});
      advance();
    },
    [card, advance],
  );

  const onNamed = useCallback(
    async (name: string) => {
      setNaming(false);
      const sp = await db.addSpeaker(meetingId, name.trim()).catch(() => null);
      if (sp) await setOwner(JSON.stringify({ kind: 'speaker', id: sp.id, confidence: 'high' }), sp.displayName);
    },
    [meetingId, setOwner],
  );

  const fixMenu: SheetAction[] = [
    { icon: 'users', label: 'Who owns it', hint: 'Pick a speaker, or name someone.', onPress: () => setFixing('owner') },
    { icon: 'clock', label: 'Which day', hint: 'The words stay as spoken; you choose the day.', onPress: () => setFixing('date') },
    { icon: 'list', label: 'What kind of statement', hint: 'Commitment, request, proposal…', onPress: () => setFixing('type') },
  ];

  const dayActions: SheetAction[] = useMemo(() => {
    const start = meeting ? meetingDayUtc(meeting.createdAt) : Date.UTC(2026, 0, 1);
    const days: SheetAction[] = [];
    for (let i = 0; i < DAY_CHOICES; i++) {
      const ms = start + i * 86_400_000;
      days.push({ icon: 'clock', label: dayLabel(ms), onPress: () => setDay(ms) });
    }
    days.push({ icon: 'x', label: 'No date', hint: 'Keep the words; pin no day.', destructive: false, onPress: () => setDay(null) });
    return days;
  }, [meeting, setDay]);

  const typeActions: SheetAction[] = TYPE_CHOICES.map(t => ({ icon: 'list', label: t.label, onPress: () => setType(t.key) }));

  const labels = card ? labelsFor({ itemType: card.itemType, status: card.status, dateNorm: card.dateNorm }) : {};

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8), paddingBottom: insets.bottom + s(16) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <View style={st.flex}>
          <Txt variant="sectionTitle">Needs a look</Txt>
          {queue.length > 0 ? (
            <Txt variant="chipSoft" color={colors.inkSoft}>
              {`${Math.min(at + 1, queue.length)} of ${queue.length}`}
            </Txt>
          ) : null}
        </View>
      </View>

      {!card ? (
        <View style={st.empty}>
          <Txt variant="body" color={colors.inkSoft}>
            {loaded ? 'Nothing left to look at.' : 'Loading…'}
          </Txt>
        </View>
      ) : (
        <ScrollView contentContainerStyle={st.pad} showsVerticalScrollIndicator={false}>
          <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={6}>
            <View style={st.card}>
              <Txt variant="prose">{sentenceCase(splitAction(card.text).text)}</Txt>
              {card.anchorStartMs !== null ? (
                <View style={st.row}>
                  <ProvenanceButton anchorStartMs={card.anchorStartMs} onOpen={player.playFrom} canPlay={player.available} />
                </View>
              ) : null}

              <View style={st.readRow}>
                {labels.type ? (
                  <View style={[st.chip, { backgroundColor: colors.primarySoft }]}>
                    <Txt variant="chipSm" color={colors.primary}>
                      {labels.type}
                    </Txt>
                  </View>
                ) : null}
                {labels.status ? (
                  <View style={[st.chip, { backgroundColor: colors.warningSoft }]}>
                    <Txt variant="chipSm" color={colors.warning}>
                      {labels.status}
                    </Txt>
                  </View>
                ) : null}
                <View style={[st.chip, { backgroundColor: colors.cardAlt }]}>
                  <Icon name="users" size={s(11)} color={colors.inkSoft} strokeWidth={2.6} />
                  <Txt variant="chipSm" color={colors.inkSoft}>
                    {ownerLabel(card.ownerJson, speakers)}
                  </Txt>
                </View>
                {card.dateSaid ? (
                  <View style={[st.chip, { backgroundColor: colors.cardAlt }]}>
                    <Icon name="clock" size={s(11)} color={colors.inkSoft} strokeWidth={2.6} />
                    <Txt variant="chipSm" color={colors.inkSoft}>
                      {labels.day ? `${card.dateSaid} → ${labels.day}` : `${card.dateSaid} → which day?`}
                    </Txt>
                  </View>
                ) : null}
              </View>

              {card.status && card.status !== 'open' && reply ? (
                <View style={[st.reply, { borderLeftColor: colors.warning }]}>
                  <Txt variant="chipSoft" color={colors.inkSoft}>
                    {`${speakers.find(x => x.id === reply.speakerId)?.displayName ?? 'Someone'} replied:`}
                  </Txt>
                  <Txt variant="body">“{reply.text.trim()}”</Txt>
                  <View style={st.row}>
                    <ProvenanceButton anchorStartMs={reply.startMs} onOpen={player.playFrom} canPlay={player.available} />
                  </View>
                </View>
              ) : null}

              {reason ? (
                <View style={st.why}>
                  <Icon name="alert" size={s(16)} color={colors.warning} strokeWidth={2.4} />
                  <Txt variant="chipSoft" color={colors.inkSoft}>
                    {REASON_TEXT[reason]}
                  </Txt>
                </View>
              ) : null}
            </View>
          </Raised>

          <View style={st.actions}>
            <Action label="Confirm" icon="check" tone={colors.primaryDeep} onPress={confirm} st={st} colors={colors} />
            <Action label="Fix" icon="edit" tone={colors.primaryDeep} onPress={() => setFixing('menu')} st={st} colors={colors} />
            <Action label="Not an item" icon="x" tone={colors.danger} onPress={reject} st={st} colors={colors} />
          </View>
        </ScrollView>
      )}

      <Sheet visible={fixing === 'menu'} title="What needs fixing?" actions={fixMenu} onClose={() => setFixing(null)} />
      <Sheet visible={fixing === 'date'} title="Which day?" actions={dayActions} onClose={() => setFixing(null)} />
      <Sheet visible={fixing === 'type'} title="What kind of statement?" actions={typeActions} onClose={() => setFixing(null)} />
      <SpeakerPicker
        visible={fixing === 'owner' && !naming}
        lineText={card ? splitAction(card.text).text : ''}
        speakers={speakers}
        currentId={null}
        scopes={false}
        onPick={id =>
          setOwner(
            JSON.stringify({ kind: 'speaker', id, confidence: 'high' }),
            speakers.find(x => x.id === id)?.displayName ?? '',
          )
        }
        onNew={() => setNaming(true)}
        onClose={() => setFixing(null)}
      />
      <TextPrompt
        visible={naming}
        title="Who owns it?"
        hint="A name for someone who was not a separated voice in the room."
        initial=""
        placeholder="Name"
        confirmLabel="Add"
        onCancel={() => setNaming(false)}
        onSubmit={onNamed}
      />
    </View>
  );
}

/** One of the card's three answers. The label is the accessibility label, so a test can press it. */
function Action({
  label, icon, tone, onPress, st, colors,
}: {
  label: string; icon: IconName; tone: string; onPress: () => void; st: ReturnType<typeof makeStyles>; colors: Colors;
}) {
  return (
    <View style={st.flex}>
      <Raised edge={colors.line} fill={colors.card} rad={radius.lg} depth={4}>
        <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={st.action}>
          <Icon name={icon} size={s(18)} color={tone} strokeWidth={2.4} />
          <Txt variant="label" style={st.actionLabel}>
            {label}
          </Txt>
        </Pressable>
      </Raised>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20), marginBottom: s(12) },
    flex: { flex: 1 },
    pad: { paddingHorizontal: s(20), paddingBottom: s(30), gap: s(16) },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: s(24) },
    card: { padding: s(18), gap: s(12) },
    row: { flexDirection: 'row', alignItems: 'center', gap: s(8) },
    readRow: { flexDirection: 'row', flexWrap: 'wrap', gap: s(6) },
    chip: { flexDirection: 'row', alignItems: 'center', gap: s(4), paddingHorizontal: s(8), paddingVertical: s(4), borderRadius: s(8) },
    reply: { borderLeftWidth: 3, paddingLeft: s(12), gap: s(6) },
    why: { flexDirection: 'row', alignItems: 'center', gap: s(8) },
    actions: { flexDirection: 'row', gap: s(10) },
    action: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: s(6), paddingVertical: s(12), paddingHorizontal: s(6) },
    // flex 1 on the label, not its measured width: the custom font measures short on Android.
    actionLabel: { flexShrink: 1, textAlign: 'center' },
  });
}
