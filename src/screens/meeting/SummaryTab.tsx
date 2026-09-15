import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Icon, { type IconName } from '../../components/Icon';
import { IconButton, Raised, Slide, SoftButton, Txt } from '../../components/ui';
import { ProvenanceButton } from './ItemProvenance';
import { SectionHead } from './shared';
import type { Highlight } from './highlights';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { EditTarget, Item, Minute, Speaker } from '../../pipeline/types';
import Llm from '../../native/NativeLlm';
import Licence from '../../native/NativeLicence';
import { TRIAL_DAYS, entitlement } from '../../billing/trial';
import {
  DOC_KEY,
  EditedTag,
  Prose,
  ToolButton,
  editedText,
  isEdited,
  toItemRows,
  type EditMap,
} from './shared';

/**
 * The landing tab: what the conversation was about, in prose.
 *
 * Deliberately NOT a work list. It used to fall back to "30 actions, 0 decisions and 17 open
 * questions came out of this meeting" and carry the top three action items underneath, which meant
 * the first thing you read about a meeting was a count of its own output. Counting is not
 * summarising, and the Actions tab already exists.
 *
 * What remains of the counting is the strip of three, and it is a WAY IN rather than a readout —
 * each one opens the tab that holds those rows. That is why it counts [toItemRows]' output and not
 * a table: a number that disagrees with the list it links to is worse than no number.
 *
 * When there is no prose the tab says so and offers the fix, rather than filling the space with
 * something that looks like an answer.
 */
export default function SummaryTab({
  items,
  minutes,
  speakers,
  speechMs,
  highlights,
  onOpenProvenance,
  canPlay,
  onRemoveMark,
  onWrite,
  onOpenTab,
  onCopy,
  edits,
  onEdit,
  onRevert,
  onUpgrade,
  writing,
}: {
  /**
   * Taken for the COUNTERS alone — the prose still comes from `minutes`, which is where it lives.
   *
   * This tab's strip links to the MOM and Actions tabs, so it has to count the rows THOSE tabs
   * will draw, and both build that list with [toItemRows]. It counted `minutes` directly until
   * Task 12, and got the right answer only because the two tables happened to hold the same
   * sentences: `replaceMinutes` still writes the item kinds. A hand-typed row broke the
   * coincidence in both directions — see below.
   */
  items: Item[];
  minutes: Minute[];
  speakers: Speaker[];
  speechMs: number;
  onWrite: () => void;
  onOpenTab: (tab: string) => void;
  /** Copy the prose itself — not the whole document, which is what the MOM tab offers. */
  onCopy?: (text: string) => void;
  edits?: EditMap;
  onEdit?: (initial: string, kind: EditTarget) => void;
  onRevert?: (kind: EditTarget) => void;
  /** Open the paywall. Only ever reached from the locked card, which is the moment it means something. */
  onUpgrade?: () => void;
  writing: boolean;
  /** Moments marked while recording, resolved to what was said (highlightsFor). */
  highlights: Highlight[];
  onOpenProvenance: (ms: number) => void;
  canPlay: boolean;
  onRemoveMark: (id: number) => void;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const ed: EditMap = edits ?? new Map();

  const written = minutes.find(m => m.kind === 'summary' && m.source === 'llm')?.content;
  // An edit wins even where there is no original: a summary somebody typed on a phone that cannot
  // run the model is still the summary of that meeting.
  const prose = editedText(ed, 'summary', DOC_KEY, written);
  const proseEdited = isEdited(ed, 'summary', DOC_KEY);
  const mins = Math.max(1, Math.round(speechMs / 60000));

  // THE SAME LIST THE TABS THIS LINKS TO WILL DRAW, and not a second count of its own.
  //
  // These three read `minutes` directly until Task 12, and were right only by coincidence: the
  // pipeline writes every decision, action and question to BOTH tables, so counting either gave
  // the same number. A row a person typed was the exception at each end of the move. Before it, a
  // typed decision was a `minutes` row and was counted here; after it, the row is an `items` row
  // and `AudioDb.carryUserMinutesOntoItems` DELETES the minute it came from — so a newly typed
  // action never incremented this, migrating decremented it by however many rows somebody had
  // typed, and a meeting whose only item-kind content is hand-typed lost the whole strip, which is
  // gated on the total below. Nothing threw and nothing was tested.
  //
  // `toItemRows` is the one place the merge is decided — items, plus the whole `minutes` list for
  // a meeting whose migration has not run — so counting its output makes this agree with the MOM
  // and Actions tabs by construction rather than by two tables happening to say the same thing.
  const rows = React.useMemo(() => toItemRows(items, minutes), [items, minutes]);
  const actions = rows.filter(r => r.kind === 'action').length;
  const decisions = rows.filter(r => r.kind === 'decision').length;
  const questions = rows.filter(r => r.kind === 'question').length;

  // Why there is no summary decides what we can honestly offer. A lapsed subscription is a
  // sentence, not a fix we can offer from here; a missing model is a Settings trip; a capable
  // phone that simply has not run narration yet — every meeting recorded before this feature
  // shipped — just needs the pipeline run again.
  //
  // Checked even when prose EXISTS, because a lapsed subscriber keeps every summary already
  // written and must not be offered a "Write it again" that would silently do nothing.
  const [reason, setReason] = React.useState<
    'checking' | 'expired' | 'locked' | 'no-model' | 'weak-device' | 'not-run'
  >('checking');
  const [lapsedCopy, setLapsedCopy] = React.useState('');
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const licence = await Licence.status();
        if (!alive) return;
        setLapsedCopy(licence.lapsedCopy);
        if (licence.state === 'expired') {
          setReason('expired');
          return;
        }
        // Checked BEFORE the prose short-circuit, for the same reason the lapsed check is:
        // somebody whose trial has run out keeps every summary already written, and must not be
        // offered a "Write it again" that would silently do nothing. `expired` above only catches
        // a lapsed SUBSCRIPTION; this catches a spent trial and never having had either.
        //
        // For a user with no prose it is also the honest answer to "why is there no summary" —
        // not "download something in Settings", because that download is gated too.
        const ent = await entitlement();
        if (!alive) return;
        if (!ent.paid) {
          setReason('locked');
          return;
        }
        if (prose) return;

        const [available, capable] = await Promise.all([Llm.available(), Llm.capable()]);
        if (!alive) return;
        setReason(!available ? 'no-model' : !capable ? 'weak-device' : 'not-run');
      } catch {
        if (alive) setReason('not-run');
      }
    })();
    return () => {
      alive = false;
    };
  }, [prose]);

  return (
    <ScrollView contentContainerStyle={st.pad} showsVerticalScrollIndicator={false}>
      {highlights.length > 0 ? (
        <View style={st.highlights}>
          <SectionHead label="HIGHLIGHTS" count={highlights.length} colors={colors} />
          {highlights.map(h => (
            <Raised key={h.id} edge={colors.line} fill={colors.card} rad={radius.card} depth={4}>
              <View style={st.highlight}>
                <View style={st.flex}>
                  <Txt variant="body" color={h.text ? colors.ink : colors.inkSoft}>
                    {h.text ?? 'Nothing said here yet'}
                  </Txt>
                  <ProvenanceButton
                    anchorStartMs={h.anchorStartMs}
                    onOpen={onOpenProvenance}
                    canPlay={canPlay}
                  />
                </View>
                <IconButton icon="x" label="Remove this mark" onPress={() => onRemoveMark(h.id)} />
              </View>
            </Raised>
          ))}
        </View>
      ) : null}
      <Slide>
        <Raised
          edge={colors.primaryEdge}
          gradient={{ from: colors.primary, to: colors.primaryLight, angle: 135 }}
          rad={radius.card24}
          depth={6}>
          <View style={st.gist}>
            {/* The meeting's shape, on the card rather than in tiles of its own below. Two large
                white boxes to hold the numerals 18 and 3 was most of a screen spent on a fact
                that fits on one line. */}
            <View style={st.headRow}>
              <Txt variant="overlineSm" color={colors.onPrimary}>
                SUMMARY
              </Txt>
              <Txt variant="chipSoft" color={colors.onPrimary} style={st.dim}>
                {mins} min · {speakers.length || '—'}{' '}
                {speakers.length === 1 ? 'speaker' : 'speakers'}
              </Txt>
              {/* Only where there is prose. Offering Copy over one of the four "why there is no
                  summary" messages would put an explanation on somebody's clipboard, and offering
                  Edit would invite them to correct a sentence about a missing model. */}
              {prose ? (
                <View style={st.tools}>
                  {onEdit ? (
                    <ToolButton
                      icon="edit"
                      label="Edit"
                      hint="Correct the summary"
                      colors={colors}
                      tone={colors.onPrimary}
                      onPress={() => onEdit(prose, 'summary')}
                    />
                  ) : null}
                  {onCopy ? (
                    <ToolButton
                      icon="copy"
                      label="Copy"
                      hint="Copies the summary text"
                      colors={colors}
                      tone={colors.onPrimary}
                      onPress={() => onCopy(prose)}
                    />
                  ) : null}
                </View>
              ) : null}
            </View>
            {prose ? (
              <>
                <Prose text={prose} colors={colors} color={colors.onPrimary} />
                {proseEdited ? (
                  <EditedTag
                    colors={colors}
                    tone={colors.onPrimary}
                    onRevert={onRevert ? () => onRevert('summary') : undefined}
                  />
                ) : null}
              </>
            ) : (
              <Txt variant="prose" color={colors.onPrimary}>
                {reason === 'expired'
                  ? lapsedCopy
                  : reason === 'locked'
                    ? // Describes what they would GET, on the meeting in front of them, rather
                      // than what they lack. The decisions and actions below are already theirs.
                      'The minutes below were pulled out of what was said. Pro writes the meeting up in plain English on this phone — who said what, what was settled, what is still open.'
                    : reason === 'no-model'
                      ? 'The summary is written on your phone by a language model that has not been downloaded yet.'
                      : reason === 'weak-device'
                        ? 'This phone does not have enough memory to write the summary on-device.'
                        : 'This meeting was processed before summaries were written. Run it again and one will be.'}
              </Txt>
            )}
            {!prose && reason === 'no-model' ? (
              <Txt variant="chipSoft" color={colors.onPrimary} style={st.note}>
                Settings → Models
              </Txt>
            ) : null}
            {!prose && reason === 'locked' && onUpgrade ? (
              <View style={st.cta}>
                <SoftButton
                  icon="ai"
                  label={`Try it free for ${TRIAL_DAYS} days`}
                  onPress={onUpgrade}
                />
              </View>
            ) : null}
          </View>
        </Raised>
      </Slide>

      {/* What came out of the meeting, as a way in rather than as a readout. Each one opens the
          tab that holds it, which is the question a count actually raises. */}
      {actions + decisions + questions > 0 ? (
        <View style={st.glance}>
          <Glance
            icon="check"
            n={actions}
            label={actions === 1 ? 'action' : 'actions'}
            color={colors.warning}
            soft={colors.warningSoft}
            onPress={() => onOpenTab('actions')}
            c={colors}
          />
          <Glance
            icon="check"
            n={decisions}
            label={decisions === 1 ? 'decision' : 'decisions'}
            color={colors.primary}
            soft={colors.primarySoft}
            onPress={() => onOpenTab('mom')}
            c={colors}
          />
          <Glance
            icon="help"
            n={questions}
            label="open"
            color={colors.success}
            soft={colors.successSoft}
            onPress={() => onOpenTab('actions')}
            c={colors}
          />
        </View>
      ) : null}

      {/* Offered once there IS prose too. A summary is a judgement call, not a lookup, and the
          only recourse when the model has written a poor one is to ask it again — there is
          nothing else on the screen that can change the answer. Withheld when the model is
          missing or the phone cannot run it, where the button would be an empty promise. */}
      {(prose || reason === 'not-run') && reason !== 'expired' && reason !== 'locked' ? (
        <SoftButton
          icon="refresh"
          label={writing ? 'Working…' : prose ? 'Write it again' : 'Write the summary'}
          onPress={onWrite}
          disabled={writing}
        />
      ) : null}

      {/* A lapsed subscriber keeps every summary already written — they are notes about the
          user's own meetings, not a rented view of them. What stops is writing new ones, and
          saying so once here is better than a button that fails silently. */}
      {reason === 'expired' && prose ? (
        <Txt variant="chipSoft" color={colors.inkDim} style={st.lapsed}>
          {lapsedCopy}
        </Txt>
      ) : null}

      {/* Same rule for a spent trial: what was written stays written. Said here rather than left
          to a "Write it again" button that would do nothing. */}
      {reason === 'locked' && prose ? (
        <>
          <Txt variant="chipSoft" color={colors.inkDim} style={st.lapsed}>
            Summaries already written are yours to keep. Writing new ones needs Pro.
          </Txt>
          {onUpgrade ? <SoftButton icon="ai" label="See Pro" onPress={onUpgrade} /> : null}
        </>
      ) : null}
    </ScrollView>
  );
}

function Glance({
  icon,
  n,
  label,
  color,
  soft,
  onPress,
  c,
}: {
  icon: IconName;
  n: number;
  label: string;
  color: string;
  soft: string;
  onPress: () => void;
  c: Colors;
}) {
  const st = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      style={st.glanceFlex}
      accessibilityRole="button"
      accessibilityLabel={`${n} ${label}`}
      onPress={onPress}>
      <Raised edge={c.line} fill={c.card} rad={radius.xl} depth={4}>
        <View style={st.glanceCard}>
          <View style={[st.glanceIcon, { backgroundColor: soft }]}>
            <Icon name={icon} size={s(14)} color={color} strokeWidth={2.8} />
          </View>
          <Txt variant="statNumSm" color={c.ink}>
            {n}
          </Txt>
          <Txt variant="chipSoft" color={c.inkDim}>
            {label}
          </Txt>
        </View>
      </Raised>
    </Pressable>
  );
}

function makeStyles(_c: Colors) {
  return StyleSheet.create({
    pad: { paddingHorizontal: s(16), paddingBottom: s(30), gap: s(14) },
    highlights: { gap: s(10) },
    highlight: { flexDirection: 'row', gap: s(10), padding: s(14), alignItems: 'flex-start' },
    flex: { flex: 1, gap: s(8) },
    gist: { padding: s(18), gap: s(12) },
    headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    dim: { opacity: 0.8 },
    tools: { flexDirection: 'row', gap: s(14) },
    cta: { marginTop: s(4) },
    note: { opacity: 0.85 },
    lapsed: { textAlign: 'center', paddingHorizontal: s(12) },
    glance: { flexDirection: 'row', gap: s(10) },
    glanceFlex: { flex: 1 },
    glanceCard: { paddingVertical: s(12), alignItems: 'center', gap: s(4) },
    glanceIcon: {
      width: s(26),
      height: s(26),
      borderRadius: s(9),
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: s(2),
    },
  });
}
