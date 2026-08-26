import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Icon from '../../components/Icon';
import { Raised, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Minute } from '../../pipeline/types';
import { db } from '../../db/queries';

/**
 * A stable key for one action item.
 *
 * NOT the minutes row id: those are deleted and re-inserted every time a meeting is reprocessed or
 * its speakers are merged, so keying on them would silently uncheck everything the user had worked
 * through. Normalised text survives all of that, and changes only when the wording does — which is
 * the case where an unticked box is the right answer anyway.
 *
 * Exported for the test that pins the normalisation.
 */
export function itemKey(content: string): string {
  const norm = content.trim().toLowerCase().replace(/\s+/g, ' ');
  let h = 0;
  for (let i = 0; i < norm.length; i++) {
    h = (h * 31 + norm.charCodeAt(i)) | 0;
  }
  return `${norm.length}:${h}`;
}

/**
 * The worklist.
 *
 * Every item here came from rule extraction, so each one quotes something that was actually said —
 * measured invented=0 across four AMI fixtures. That is why the LLM's prose does not feed this tab:
 * on the same recording the rules found 7 actions with quotes and the model returned 2, with a
 * due-date field reading "After uploading the file".
 */
export default function ActionsTab({
  meetingId,
  minutes,
}: {
  meetingId: string;
  minutes: Minute[];
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const [done, setDone] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    let alive = true;
    db.doneActions(meetingId)
      .then(d => {
        if (alive) setDone(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [meetingId]);

  const actions = minutes.filter(m => m.kind === 'action');
  const decisions = minutes.filter(m => m.kind === 'decision');
  const questions = minutes.filter(m => m.kind === 'question');

  const toggle = React.useCallback(
    (content: string) => {
      const key = itemKey(content);
      setDone(prev => {
        const next = new Set(prev);
        const on = !next.has(key);
        if (on) next.add(key);
        else next.delete(key);
        // Optimistic: the tick should land on the next frame, not after a database round trip.
        // A failed write costs a tick, not the item.
        db.setActionDone(meetingId, key, on).catch(() => {});
        return next;
      });
    },
    [meetingId],
  );

  const nothing = actions.length === 0 && decisions.length === 0 && questions.length === 0;
  const outstanding = actions.filter(m => !done.has(itemKey(m.content))).length;

  return (
    <ScrollView contentContainerStyle={st.pad} showsVerticalScrollIndicator={false}>
      {nothing ? (
        <Txt variant="body" color={colors.inkSoft} style={st.empty}>
          Nothing to act on came out of this meeting.
        </Txt>
      ) : null}

      {actions.length > 0 ? (
        <>
          <Txt variant="overlineSm" color={colors.inkFaint}>
            {outstanding > 0 ? `TO DO · ${outstanding} LEFT` : 'TO DO · ALL DONE'}
          </Txt>
          <View style={st.list}>
            {actions.map((m, i) => {
              const on = done.has(itemKey(m.content));
              return (
                <Pressable
                  key={m.id ?? i}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={m.content}
                  onPress={() => toggle(m.content)}>
                  <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={4}>
                    <View style={st.check}>
                      <View
                        style={[
                          st.box,
                          { borderColor: on ? colors.success : colors.line },
                          on && { backgroundColor: colors.successSoft },
                        ]}>
                        {on ? (
                          <Icon name="check" size={s(15)} color={colors.success} strokeWidth={3.2} />
                        ) : null}
                      </View>
                      <Txt
                        variant="minuteBody"
                        color={on ? colors.inkFaint : colors.ink}
                        style={[st.flex, on ? st.struck : null]}>
                        {m.content}
                      </Txt>
                    </View>
                  </Raised>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}

      {decisions.length > 0 ? (
        <>
          <Txt variant="overlineSm" color={colors.inkFaint} style={st.heading}>
            DECIDED
          </Txt>
          <View style={st.list}>
            {decisions.map((m, i) => (
              <Raised key={m.id ?? i} edge={colors.line} fill={colors.card} rad={radius.xl} depth={4}>
                <View style={st.plain}>
                  <Txt variant="minuteBody">{m.content}</Txt>
                </View>
              </Raised>
            ))}
          </View>
        </>
      ) : null}

      {questions.length > 0 ? (
        <>
          <Txt variant="overlineSm" color={colors.inkFaint} style={st.heading}>
            STILL OPEN
          </Txt>
          <View style={st.list}>
            {questions.map((m, i) => (
              <Raised key={m.id ?? i} edge={colors.line} fill={colors.card} rad={radius.xl} depth={4}>
                <View style={st.plain}>
                  <Txt variant="minuteBody">{m.content}</Txt>
                </View>
              </Raised>
            ))}
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    pad: { paddingHorizontal: s(16), paddingBottom: s(30), gap: s(10) },
    empty: { paddingVertical: s(30), textAlign: 'center' },
    list: { gap: s(10) },
    heading: { marginTop: s(8) },
    check: { flexDirection: 'row', gap: s(12), padding: s(14), alignItems: 'flex-start' },
    plain: { padding: s(14) },
    box: {
      width: s(24),
      height: s(24),
      borderRadius: s(8),
      borderWidth: s(2),
      alignItems: 'center',
      justifyContent: 'center',
    },
    flex: { flex: 1 },
    struck: { textDecorationLine: 'line-through' },
  });
}
