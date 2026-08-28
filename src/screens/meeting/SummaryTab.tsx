import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Raised, Slide, SoftButton, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Minute, Speaker } from '../../pipeline/types';
import Llm from '../../native/NativeLlm';

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
  writing,
}: {
  minutes: Minute[];
  speakers: Speaker[];
  speechMs: number;
  onWrite: () => void;
  writing: boolean;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);

  const prose = minutes.find(m => m.kind === 'summary' && m.source === 'llm')?.content;
  const mins = Math.max(1, Math.round(speechMs / 60000));

  // Why there is no summary decides what we can honestly offer. A missing model is a Settings
  // trip; a capable phone that simply has not run narration yet — every meeting recorded before
  // this feature shipped — just needs the pipeline run again.
  const [reason, setReason] = React.useState<'checking' | 'no-model' | 'weak-device' | 'not-run'>(
    'checking',
  );
  React.useEffect(() => {
    if (prose) return;
    let alive = true;
    (async () => {
      try {
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
            <Txt variant="overlineSm" color={colors.onPrimary}>
              SUMMARY
            </Txt>
            {prose ? (
              // `minuteBody`, not `gist`. The gist face is 17/900 black, drawn for the one or two
              // lines it was named after; a real summary runs a paragraph, and at that length the
              // display weight stops being emphasis and becomes a wall. The MOM tab already sets
              // its prose this way.
              <Txt variant="minuteBody" color={colors.onPrimary} style={st.gistText}>
                {prose}
              </Txt>
            ) : (
              <Txt variant="gist" color={colors.onPrimary} style={st.gistText}>
                {reason === 'no-model'
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

      {/* Offered once there IS prose too. A summary is a judgement call, not a lookup, and the
          only recourse when the model has written a poor one is to ask it again — there is
          nothing else on the screen that can change the answer. Withheld when the model is
          missing or the phone cannot run it, where the button would be an empty promise. */}
      {prose || reason === 'not-run' ? (
        <SoftButton
          icon="refresh"
          label={writing ? 'Working…' : prose ? 'Write it again' : 'Write the summary'}
          onPress={onWrite}
          disabled={writing}
        />
      ) : null}

      <View style={st.factRow}>
        <Fact value={`${mins}`} label={mins === 1 ? 'minute' : 'minutes'} c={colors} />
        <Fact
          value={`${speakers.length || '—'}`}
          label={speakers.length === 1 ? 'speaker' : 'speakers'}
          c={colors}
        />
      </View>
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

function makeStyles(_c: Colors) {
  return StyleSheet.create({
    pad: { paddingHorizontal: s(16), paddingBottom: s(30), gap: s(14) },
    gist: { padding: s(18), gap: s(8) },
    gistText: { marginTop: s(2) },
    note: { opacity: 0.85, marginTop: s(4) },
    factRow: { flexDirection: 'row', gap: s(10) },
    factFlex: { flex: 1 },
    fact: { paddingVertical: s(14), alignItems: 'center', gap: s(2) },
  });
}
