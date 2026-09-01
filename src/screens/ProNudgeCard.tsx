/**
 * The recurring offer of Pro, as a card above the meeting list.
 *
 * Deliberately not a full-screen takeover. A takeover arriving the moment a meeting finishes lands
 * exactly when somebody opened the app to read something, and "it keeps nagging me" is the
 * complaint this product is positioned against — the whole reason a privacy-first note-taker has
 * an opening at all. A card is in front of them every time they open the library and blocks
 * nothing.
 *
 * Whether it appears is decided by shouldNudgeForPro in billing/trial.ts. This file only draws it,
 * which is what keeps the rule unit-testable without a screen.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Raised, SoftButton, Txt } from '../components/ui';
import { s, useTheme, type Colors } from '../theme';

export default function ProNudgeCard({
  meetings,
  onOpen,
  onDismiss,
}: {
  meetings: number;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);

  return (
    <Raised style={st.card}>
      <Txt variant="cardTitle">Your {meetings} meetings, written up</Txt>
      <Txt variant="meta" color={colors.inkDim} style={st.body}>
        Pro reads the whole transcript and writes the minutes in sentences you can send to someone
        who was not there. Seven days free, on your own meetings.
      </Txt>
      <View style={st.row}>
        <View style={st.grow}>
          <Button label="See what it does" icon="ai" onPress={onOpen} full />
        </View>
        <SoftButton label="Not now" onPress={onDismiss} />
      </View>
    </Raised>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    card: { padding: s(16), marginBottom: s(14), backgroundColor: c.card },
    body: { marginTop: s(6), marginBottom: s(12) },
    row: { flexDirection: 'row', gap: s(10), alignItems: 'center' },
    grow: { flex: 1 },
  });
}
