import React, { useEffect, useMemo, useState } from 'react';
import { NativeModules, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { IconButton, Txt } from '../components/ui';
import { s, useTheme, type Colors } from '../theme';
import { consentCardText } from './consent';

type Props = NativeStackScreenProps<RootStackParamList, 'ConsentCard'>;

/**
 * The card you hold up to the room.
 *
 * A poster, not a form. No state, no logging, and deliberately no signature capture: collecting
 * names would make this a data-collection feature inside an app whose Play Data Safety entry says
 * no data is collected.
 *
 * Sized for reading across a table rather than at arm's length, which is why the type is far
 * larger than anywhere else in the app.
 */
export default function ConsentCardScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const [region, setRegion] = useState<string | null>(null);

  useEffect(() => {
    // Offline: the SIM's network country, falling back to the device locale. Never a network call
    // and never a location permission — see src/screens/consent.ts.
    const mod = NativeModules.AudioPipeline as { regionCode?: () => Promise<string> } | undefined;
    mod?.regionCode?.()
      .then(setRegion)
      .catch(() => setRegion(null));
  }, []);

  const text = consentCardText(region);

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8), paddingBottom: insets.bottom + s(24) }]}>
      <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
      <View style={st.body}>
        <Txt variant="display" style={st.title}>
          {text.title}
        </Txt>
        <Txt variant="body" color={colors.inkSoft} style={st.para}>
          {text.body}
        </Txt>
      </View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas, paddingHorizontal: s(24) },
    body: { flex: 1, justifyContent: 'center' },
    // Deliberately outsized: this is read from the other side of a table, not at arm's length.
    title: { fontSize: s(40), lineHeight: s(46), textAlign: 'center' },
    para: { fontSize: s(20), lineHeight: s(30), textAlign: 'center', marginTop: s(24) },
  });
}
