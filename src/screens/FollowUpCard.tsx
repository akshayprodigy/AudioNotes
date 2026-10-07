import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Icon from '../components/Icon';
import { Raised, Txt } from '../components/ui';
import { radius, s, useTheme, type Colors } from '../theme';
import { previewOf, type FollowUp } from './followUpData';

export type FollowUpKind = 'due' | 'decisions' | 'review';

/**
 * The Library's one follow-up card (Pro only; the caller does not draw it for Free).
 *
 * It grew out of the open-actions card: that card is its first line and still opens the Actions
 * list. Beneath it sit up to three quiet rows, each a count and a preview of the first item, each
 * opening its filtered list. A row with nothing in it is not drawn ("0 decisions still open" is a
 * nag), and the card itself is not drawn when every count is zero.
 */
export function followUpVisible(work: { open: number }, f: FollowUp): boolean {
  return work.open > 0 || f.due.length > 0 || f.decisions.length > 0 || f.review.length > 0;
}

export default function FollowUpCard({
  work,
  follow,
  onOpenActions,
  onOpenList,
}: {
  work: { open: number; meetings: number };
  follow: FollowUp;
  onOpenActions: () => void;
  onOpenList: (kind: FollowUpKind) => void;
}) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);

  const rows: { kind: FollowUpKind; title: string; count: number; preview: string }[] = [
    {
      kind: 'due',
      title: 'Due or overdue actions',
      count: follow.due.length,
      preview: follow.due[0] ? previewOf(follow.due[0].content) : '',
    },
    {
      kind: 'decisions',
      title: 'Decisions still open',
      count: follow.decisions.length,
      preview: follow.decisions[0] ? previewOf(follow.decisions[0].content) : '',
    },
    {
      kind: 'review',
      title: 'Notes to review',
      count: follow.review.length,
      preview: follow.review[0] ? previewOf(follow.review[0].firstText) : '',
    },
  ];

  return (
    <View style={st.wrap} accessibilityLabel="Follow-up">
      <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={6} pressable={false}>
        <View style={st.card}>
          <Txt variant="overlineSm" color={colors.inkFaint} style={st.overline}>
            FOLLOW-UP
          </Txt>
          {work.open > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open actions"
              onPress={onOpenActions}
              style={st.row}>
              <View style={[st.icon, { backgroundColor: colors.primarySoft }]}>
                <Icon name="list" size={s(20)} color={colors.primary} strokeWidth={2.4} />
              </View>
              <View style={st.flex}>
                <Txt variant="bodyBlack">
                  {work.open} open action{work.open === 1 ? '' : 's'}
                </Txt>
                <Txt variant="chipSoft" color={colors.inkSoft}>
                  across {work.meetings} meeting{work.meetings === 1 ? '' : 's'}
                </Txt>
              </View>
              <Icon name="chevronRight" size={s(18)} color={colors.inkFaint} />
            </Pressable>
          ) : null}
          {rows
            .filter(r => r.count > 0)
            .map(r => (
              <Pressable
                key={r.kind}
                accessibilityRole="button"
                accessibilityLabel={r.title}
                accessibilityHint={`${r.count}. ${r.preview}`}
                onPress={() => onOpenList(r.kind)}
                style={st.row}>
                <View style={st.flex}>
                  <Txt variant="bodyStrong">{r.title}</Txt>
                  <Txt variant="chipSoft" color={colors.inkSoft} numberOfLines={1}>
                    {r.preview}
                  </Txt>
                </View>
                <Txt variant="bodyBlack" color={colors.inkDim}>
                  {String(r.count)}
                </Txt>
                <Icon name="chevronRight" size={s(18)} color={colors.inkFaint} />
              </Pressable>
            ))}
        </View>
      </Raised>
    </View>
  );
}

function makeStyles(_c: Colors) {
  return StyleSheet.create({
    wrap: { paddingHorizontal: s(20), marginTop: s(10) },
    card: { padding: s(14), gap: s(2) },
    overline: { marginBottom: s(4) },
    flex: { flex: 1 },
    row: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingVertical: s(8) },
    icon: {
      width: s(38),
      height: s(38),
      borderRadius: s(12),
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}
