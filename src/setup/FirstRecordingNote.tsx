import React from 'react';
import { StyleSheet, View } from 'react-native';
import Icon from '../components/Icon';
import { Raised, Txt } from '../components/ui';
import { firstRecordingNote } from '../billing/allowanceCopy';
import { radius, s, useTheme } from '../theme';

/**
 * The one short card before the first real recording: the language, then the Free allowance, in
 * the words every other surface uses (allowanceCopy). A fact, not a plan decision. Pro and an
 * unanswered `paid` get the language alone.
 */
export default function FirstRecordingNote({ paid }: { paid: boolean | null }) {
  const { colors } = useTheme();
  return (
    // The Record screen centres its scroll content, which shrink-wraps a card to its own width, and
    // the text beside the icon is flex: 1 — so it measured zero and only the icon showed. Found on
    // a Galaxy A07's first run. The wrapper gives the card the screen's width to be flexible in.
    <View style={styles.wrap} testID="first-recording-note">
      <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
        <View style={styles.row}>
          <View style={[styles.icon, { backgroundColor: colors.primarySoft }]}>
            <Icon name="chat" size={s(20)} color={colors.primary} strokeWidth={2.4} />
          </View>
          <Txt variant="chip" color={colors.inkSoft} style={styles.flex}>
            {firstRecordingNote(paid)}
          </Txt>
        </View>
      </Raised>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch', paddingHorizontal: s(20) },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: s(14), padding: s(16) },
  icon: { width: s(44), height: s(44), borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
});
