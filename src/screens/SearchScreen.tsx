import React, { useMemo, useState } from 'react';
import { View, TextInput, FlatList, Text, Pressable, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import Icon from '../components/Icon';
import { useTheme, spacing, radius, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Search'>;
type Hit = { meeting_id: string; snippet: string };

export default function SearchScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [results, setResults] = useState<Hit[]>([]);
  const [term, setTerm] = useState('');

  return (
    <View style={s.root}>
      <View style={s.searchBox}>
        <Icon name="search" size={18} color={colors.textDim} />
        <TextInput
          style={s.input}
          placeholder="Search across all meetings"
          placeholderTextColor={colors.textFaint}
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
        ListEmptyComponent={
          term.length > 1 ? <Text style={s.none}>No matches.</Text> : null
        }
        renderItem={({ item }) => (
          <Pressable style={s.hit} onPress={() => navigation.navigate('Meeting', { meetingId: item.meeting_id })}>
            <Text style={s.snip}>{item.snippet}</Text>
            <Icon name="chevronRight" size={18} color={colors.textFaint} />
          </Pressable>
        )}
      />
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, padding: spacing.md, backgroundColor: c.bg },
    searchBox: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: c.surface, borderRadius: radius.md, paddingHorizontal: spacing.md, marginBottom: spacing.md, borderWidth: 1, borderColor: c.border },
    input: { flex: 1, color: c.text, paddingVertical: spacing.md },
    hit: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: c.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, borderWidth: 1, borderColor: c.border },
    snip: { flex: 1, color: c.text },
    none: { color: c.textDim, textAlign: 'center', marginTop: spacing.lg },
  });
}
