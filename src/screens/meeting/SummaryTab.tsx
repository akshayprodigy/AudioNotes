import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Raised, Slide, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Minute, Speaker } from '../../pipeline/types';
import { MinuteCard } from './shared';

/**
 * The landing tab — the first thing anyone sees when they open a meeting.
 *
 * Holds the LLM's prose when narration ran, and an honest at-a-glance card when it did not: no
 * model downloaded, a device under the RAM gate, or a recording too short to summarise without
 * inventing one. Either way the tab is worth landing on, which is why the facts and the top actions
 * sit under the prose rather than the prose sitting alone — two or three sentences on their own is
 * a near-empty screen, and people learn to skip past those.
 */
export default function SummaryTab({
  minutes,
  speakers,
  speechMs,
}: {
  minutes: Minute[];
  speakers: Speaker[];
  speechMs: number;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);

  const prose = minutes.find(m => m.kind === 'summary' && m.source === 'llm')?.content;
  const actions = minutes.filter(m => m.kind === 'action');
  const decisions = minutes.filter(m => m.kind === 'decision').length;
  const questions = minutes.filter(m => m.kind === 'question').length;
  const mins = Math.max(1, Math.round(speechMs / 60000));

  const fallback =
    `${actions.length} ${actions.length === 1 ? 'action' : 'actions'}, ` +
    `${decisions} ${decisions === 1 ? 'decision' : 'decisions'} and ` +
    `${questions} open ${questions === 1 ? 'question' : 'questions'} came out of this meeting.`;

  return (
    <ScrollView contentContainerStyle={st.pad} showsVerticalScrollIndicator={false}>
      <Slide>
        <Raised
          edge={colors.primaryEdge}
          gradient={{ from: colors.primary, to: colors.primaryLight, angle: 135 }}
          rad={radius.card24}
          depth={6}>
          <View style={st.gist}>
            <Txt variant="overlineSm" color={colors.onPrimary}>
              SUMMARY
            </Txt>
            <Txt variant="gist" color={colors.onPrimary} style={st.gistText}>
              {prose ?? fallback}
            </Txt>
            {!prose ? (
              <Txt variant="chipSoft" color={colors.onPrimary} style={st.note}>
                Written minutes need the language model — see Settings.
              </Txt>
            ) : null}
          </View>
        </Raised>
      </Slide>

      <View style={st.factRow}>
        <Fact value={`${mins}`} label={mins === 1 ? 'minute' : 'minutes'} c={colors} />
        <Fact
          value={`${speakers.length || '—'}`}
          label={speakers.length === 1 ? 'speaker' : 'speakers'}
          c={colors}
        />
        <Fact
          value={`${actions.length}`}
          label={actions.length === 1 ? 'action' : 'actions'}
          c={colors}
        />
      </View>

      {actions.length > 0 ? (
        <>
          <Txt variant="overlineSm" color={colors.inkFaint} style={st.heading}>
            TOP ACTIONS
          </Txt>
          <View style={st.list}>
            {actions.slice(0, 3).map((m, i) => (
              <MinuteCard key={m.id ?? i} m={m} i={i} colors={colors} />
            ))}
          </View>
          {actions.length > 3 ? (
            <Txt variant="chipSoft" color={colors.inkFaint} style={st.more}>
              {actions.length - 3} more in Actions
            </Txt>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

function Fact({ value, label, c }: { value: string; label: string; c: Colors }) {
  const st = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={st.factFlex}>
      <Raised edge={c.line} fill={c.card} rad={radius.xl} depth={4}>
        <View style={st.fact}>
          <Txt variant="statNum" color={c.ink}>
            {value}
          </Txt>
          <Txt variant="chipSoft" color={c.inkDim}>
            {label}
          </Txt>
        </View>
      </Raised>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    pad: { paddingHorizontal: s(16), paddingBottom: s(30), gap: s(14) },
    gist: { padding: s(18), gap: s(8) },
    gistText: { marginTop: s(2) },
    note: { opacity: 0.85, marginTop: s(4) },
    factRow: { flexDirection: 'row', gap: s(10) },
    factFlex: { flex: 1 },
    fact: { paddingVertical: s(14), alignItems: 'center', gap: s(2) },
    heading: { marginTop: s(4) },
    list: { gap: s(12) },
    more: { textAlign: 'center', marginTop: s(2) },
  });
}
