import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Icon, { type IconName } from '../../components/Icon';
import { Raised, Slide, SoftButton, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Minute, Speaker } from '../../pipeline/types';
import Llm from '../../native/NativeLlm';
import Licence from '../../native/NativeLicence';
import { Prose } from './shared';

/**
 * The landing tab: what the conversation was about, in prose.
 *
 * Deliberately NOT a work list. It used to fall back to "30 actions, 0 decisions and 17 open
 * questions came out of this meeting" and carry the top three action items underneath, which meant
 * the first thing you read about a meeting was a count of its own output. Counting is not
 * summarising, and the Actions tab already exists.
 *
 * When there is no prose the tab says so and offers the fix, rather than filling the space with
 * something that looks like an answer.
 */
export default function SummaryTab({
  minutes,
  speakers,
  speechMs,
  onWrite,
  onOpenTab,
  writing,
}: {
  minutes: Minute[];
  speakers: Speaker[];
  speechMs: number;
  onWrite: () => void;
  onOpenTab: (tab: string) => void;
  writing: boolean;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);

  const prose = minutes.find(m => m.kind === 'summary' && m.source === 'llm')?.content;
  const mins = Math.max(1, Math.round(speechMs / 60000));
  const actions = minutes.filter(m => m.kind === 'action').length;
  const decisions = minutes.filter(m => m.kind === 'decision').length;
  const questions = minutes.filter(m => m.kind === 'question').length;

  // Why there is no summary decides what we can honestly offer. A lapsed subscription is a
  // sentence, not a fix we can offer from here; a missing model is a Settings trip; a capable
  // phone that simply has not run narration yet — every meeting recorded before this feature
  // shipped — just needs the pipeline run again.
  //
  // Checked even when prose EXISTS, because a lapsed subscriber keeps every summary already
  // written and must not be offered a "Write it again" that would silently do nothing.
  const [reason, setReason] = React.useState<
    'checking' | 'expired' | 'no-model' | 'weak-device' | 'not-run'
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
            </View>
            {prose ? (
              <Prose text={prose} colors={colors} color={colors.onPrimary} />
            ) : (
              <Txt variant="prose" color={colors.onPrimary}>
                {reason === 'expired'
                  ? lapsedCopy
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
      {(prose || reason === 'not-run') && reason !== 'expired' ? (
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
    gist: { padding: s(18), gap: s(12) },
    headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    dim: { opacity: 0.8 },
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
