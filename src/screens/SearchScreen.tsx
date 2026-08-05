import React, { useMemo, useState } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import Icon from '../components/Icon';
import Mascot from '../components/Mascot';
import { IconButton, Pop, Raised, Txt } from '../components/ui';
import { font, radius, s, sv, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Search'>;
type Hit = { meeting_id: string; snippet: string };

export default function SearchScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [results, setResults] = useState<Hit[]>([]);
  const [term, setTerm] = useState('');

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <Txt variant="sectionTitle">Search</Txt>
      </View>

      <View style={st.searchBox}>
        <Icon name="search" size={s(19)} color={colors.inkFaint} strokeWidth={2.4} />
        <TextInput
          style={st.input}
          placeholder="Search every transcript"
          placeholderTextColor={colors.inkFaint}
          autoFocus
          value={term}
          onChangeText={t => {
            setTerm(t);
            if (t.length > 1) db.search(t).then(setResults);
            else setResults([]);
          }}
        />
      </View>

      <FlatList
        data={results}
        keyExtractor={(h, i) => h.meeting_id + i}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          st.listPad,
          { paddingBottom: insets.bottom + s(24) },
          results.length === 0 && st.emptyPad,
        ]}
        ListEmptyComponent={
          <View style={st.empty}>
            <Mascot mood={term.length > 1 ? 'thinking' : 'idle'} size={sv(120)} animated={false} />
            <Txt variant="display" style={st.emptyTitle}>
              {term.length > 1 ? 'Nothing found' : 'Search your meetings'}
            </Txt>
            <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
              {term.length > 1
                ? `No transcript mentions “${term}”.`
                : 'Find any word anyone said, across every meeting you have recorded.'}
            </Txt>
          </View>
        }
        renderItem={({ item, index }) => (
          <Pop index={index}>
            <Raised
              edge={colors.line}
              fill={colors.card}
              rad={radius.xl}
              depth={5}
              onPress={() => navigation.navigate('Meeting', { meetingId: item.meeting_id })}>
              <View style={st.hit}>
                <Txt variant="body" style={st.flex} numberOfLines={3}>
                  {item.snippet}
                </Txt>
                <Icon name="chevronRight" size={s(18)} color={colors.inkFaint} strokeWidth={2.4} />
              </View>
            </Raised>
          </Pop>
        )}
      />
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20) },
    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(10),
      backgroundColor: c.card,
      borderRadius: radius.lg,
      paddingHorizontal: s(16),
      marginHorizontal: s(20),
      marginTop: s(16),
    },
    input: {
      flex: 1,
      color: c.ink,
      paddingVertical: s(14),
      fontFamily: font.semibold,
      fontSize: s(15),
    },
    listPad: { paddingHorizontal: s(20), paddingTop: s(16), gap: s(10) },
    emptyPad: { flexGrow: 1, justifyContent: 'center' },
    hit: { flexDirection: 'row', alignItems: 'center', gap: s(12), padding: s(16) },
    empty: { alignItems: 'center', paddingHorizontal: s(20) },
    emptyTitle: { marginTop: s(18) },
    emptyBody: { textAlign: 'center', marginTop: s(6) },
  });
}
