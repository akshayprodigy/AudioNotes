import React, { useMemo, useState } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import Icon from '../components/Icon';
import Mascot from '../components/Mascot';
import { Card, FadeIn, Txt } from '../components/ui';
import { font, radius, spacing, useTheme, type Colors } from '../theme';

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
        <Icon name="search" size={18} color={colors.inkFaint} />
        <TextInput
          style={s.input}
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
        contentContainerStyle={results.length === 0 ? s.emptyPad : undefined}
        ListEmptyComponent={
          <View style={s.empty}>
            <Mascot mood={term.length > 1 ? 'thinking' : 'idle'} size={110} animated={false} />
            <Txt variant="heading" style={s.emptyTitle}>
              {term.length > 1 ? 'Nothing found' : 'Search your meetings'}
            </Txt>
            <Txt variant="body" color={colors.inkSoft} style={s.emptyBody}>
              {term.length > 1
                ? `No transcript mentions “${term}”.`
                : 'Find any word anyone said, across every meeting you have recorded.'}
            </Txt>
          </View>
        }
        renderItem={({ item, index }) => (
          <FadeIn index={index} style={s.hitWrap}>
            <Card onPress={() => navigation.navigate('Meeting', { meetingId: item.meeting_id })}>
              <View style={s.hit}>
                <Txt variant="body" style={s.snip} numberOfLines={3}>
                  {item.snippet}
                </Txt>
                <Icon name="chevronRight" size={18} color={colors.inkFaint} />
              </View>
            </Card>
          </FadeIn>
        )}
      />
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, padding: spacing.xl, backgroundColor: c.canvas },
    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.card,
      borderRadius: radius.md,
      paddingHorizontal: spacing.lg,
      marginBottom: spacing.lg,
      borderWidth: 1,
      borderColor: c.line,
    },
    input: {
      flex: 1,
      color: c.ink,
      paddingVertical: spacing.md,
      fontFamily: font.regular,
      fontSize: 15,
    },
    hitWrap: { marginBottom: spacing.sm },
    hit: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    snip: { flex: 1 },
    emptyPad: { flexGrow: 1, justifyContent: 'center' },
    empty: { alignItems: 'center', paddingHorizontal: spacing.lg },
    emptyTitle: { marginTop: spacing.lg },
    emptyBody: { textAlign: 'center', marginTop: spacing.xs },
  });
}
