import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Icon from '../../components/Icon';
import { Txt } from '../../components/ui';
import { s, useTheme, type Colors } from '../../theme';
import { entitlement } from '../../billing/trial';
import ModelManager from '../../native/NativeModelManager';
import { writerBlockedReason } from '../deviceFit';
import { askState, type AskState } from './askAccess';

/**
 * Who is asking and on what phone, for the Ask entry. Read once per opening of the meeting.
 *
 * Unknown until both answers are in, and unknown opens Ask (see askState): the entry is never
 * disabled while it finds out, and the Ask screen's own native gate is still the one that refuses.
 */
export function useAskState(): { state: AskState; writerBlocked: string | null } {
  const [paid, setPaid] = React.useState<boolean | null>(null);
  const [blocked, setBlocked] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    entitlement()
      .then(e => alive && setPaid(e.paid))
      .catch(() => {});
    ModelManager.list()
      .then(raw => alive && setBlocked(writerBlockedReason(JSON.parse(raw))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return { state: askState({ paid, writerBlocked: blocked }), writerBlocked: blocked };
}

/**
 * A visible, labelled way into Ask, on the tabs a reader lands on.
 *
 * The header already carries an icon for it, and an icon alone is exactly the thing a person has to
 * discover by accident; this one says what it does. On Free it carries a small "Pro" mark, in
 * words, so the tap is never a surprise.
 */
export default function AskEntry({
  onPress,
  pro,
}: {
  onPress: () => void;
  /** Show the "Pro" mark: this person would be told what Ask is rather than taken to it. */
  pro: boolean;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Ask this meeting"
      accessibilityHint="Ask a question about what was said, with the moment each answer came from"
      style={({ pressed }) => [st.row, { opacity: pressed ? 0.6 : 1 }]}>
      <View style={st.icon}>
        <Icon name="chat" size={s(18)} color={colors.primary} strokeWidth={2.4} />
      </View>
      <View style={st.text}>
        <Txt variant="bodyBlack" color={colors.primaryDeep}>
          Ask this meeting
        </Txt>
        <Txt variant="chipSoft" color={colors.inkSoft}>
          Answers from the transcript, with the moment each came from
        </Txt>
      </View>
      {pro ? (
        <View style={st.pro}>
          <Txt variant="chipSm" color={colors.primary}>
            Pro
          </Txt>
        </View>
      ) : null}
      <Icon name="chevronRight" size={s(16)} color={colors.inkFaint} strokeWidth={2.6} />
    </Pressable>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingVertical: s(10), minHeight: s(48) },
    icon: {
      width: s(34),
      height: s(34),
      borderRadius: s(11),
      backgroundColor: c.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    text: { flex: 1, flexShrink: 1 },
    pro: { paddingHorizontal: s(8), paddingVertical: s(3), borderRadius: s(8), backgroundColor: c.primarySoft },
  });
}
