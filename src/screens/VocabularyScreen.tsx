import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import Mascot from '../components/Mascot';
import { confirmDestructive } from '../components/confirm';
import { IconButton, Pop, Raised, SoftButton, TextPrompt, Txt } from '../components/ui';
import type { VocabularyRule } from '../pipeline/types';
import { radius, s, sv, tilt, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Vocabulary'>;

/**
 * Settings › Vocabulary (Phase 5): the words it should write. "in over" → "Innova", typed here or
 * learned from a correction in a transcript, applied to every recording after recognition. Whole
 * words, any case; the recogniser's own wording is kept underneath, so a wrong rule costs nothing
 * that cannot be undone by removing it.
 *
 * One screen, like the archive: every row exists to be acted on, so its two actions sit on the
 * card. Adding takes the prompt's two fields — what it hears, then what you mean — because the pair
 * is the rule; changing takes one, because `heard` is the key and only `meant` is ever wrong.
 */
export default function VocabularyScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [rules, setRules] = useState<VocabularyRule[]>([]);
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState<VocabularyRule | null>(null);

  const load = useCallback(() => {
    db.vocabulary().then(setRules).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    return navigation.addListener('focus', load);
  }, [navigation, load]);

  const fail = (e: unknown) => Alert.alert('Could not save that', String((e as any)?.message ?? e));

  const onAdd = (heard: string, meant: string) => {
    setAdding(false);
    if (!meant.trim()) {
      Alert.alert('Both are needed', 'Type what it hears, then what you mean.');
      return;
    }
    db.putVocabulary(heard, meant, 'typed').then(load).catch(fail);
  };

  const onChange = (value: string) => {
    const r = changing;
    setChanging(null);
    if (!r) return;
    db.putVocabulary(r.heard, value, r.source).then(load).catch(fail);
  };

  const remove = (r: VocabularyRule) =>
    confirmDestructive({
      title: `Remove “${r.heard}” → “${r.meant}”?`,
      message: 'Lines it already corrected stay as they are. New recordings will not apply it.',
      confirmLabel: 'Remove',
      onConfirm: () => {
        db.deleteVocabulary(r.id).then(load).catch(fail);
      },
    });

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <Txt variant="sectionTitle" style={st.flex}>
          Vocabulary
        </Txt>
        <SoftButton label="Add" icon="plus" onPress={() => setAdding(true)} />
      </View>

      <FlatList
        data={rules}
        keyExtractor={r => r.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          st.listPad,
          { paddingBottom: insets.bottom + s(24) },
          rules.length === 0 && st.emptyPad,
        ]}
        ListEmptyComponent={
          <View style={st.empty}>
            <Mascot mood="asleep" size={sv(120)} />
            <Txt variant="display" style={st.emptyTitle}>
              No words yet
            </Txt>
            <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
              Add a name, a company or a term it keeps mis-hearing, or say Yes when a correction in
              a transcript offers to remember it.
            </Txt>
          </View>
        }
        renderItem={({ item, index }) => (
          <Pop index={index} style={st.rowWrap}>
            <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5} rotate={tilt(index)}>
              <View style={st.card}>
                <Txt variant="cardTitleSm" numberOfLines={2}>
                  {`“${item.heard}” → “${item.meant}”`}
                </Txt>
                <Txt variant="chipSoft" color={colors.inkFaint} style={st.meta}>
                  {(item.source === 'learned' ? 'Learned from a correction' : 'Typed') +
                    ` · used ${item.uses} ${item.uses === 1 ? 'time' : 'times'}`}
                </Txt>
                <View style={st.actions}>
                  <SoftButton label="Change" icon="edit" onPress={() => setChanging(item)} />
                  <SoftButton label="Remove" icon="trash" tone={colors.danger} onPress={() => remove(item)} />
                </View>
              </View>
            </Raised>
          </Pop>
        )}
      />

      <TextPrompt
        visible={adding}
        title="Add a word"
        hint="What it hears, then what you mean. Whole words, any case; the original wording is kept."
        initial=""
        placeholder="What it hears — e.g. in over"
        extraPlaceholder="What you mean — e.g. Innova"
        confirmLabel="Add"
        onCancel={() => setAdding(false)}
        onSubmit={onAdd}
      />
      <TextPrompt
        visible={changing !== null}
        title={changing ? `Instead of “${changing.heard}”` : ''}
        hint="What it should write."
        initial={changing?.meant ?? ''}
        placeholder="What you mean"
        confirmLabel="Save"
        onCancel={() => setChanging(null)}
        onSubmit={onChange}
      />
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20) },
    listPad: { paddingHorizontal: s(20), paddingTop: s(16) },
    emptyPad: { flexGrow: 1, justifyContent: 'center' },
    rowWrap: { marginBottom: s(12) },
    card: { padding: s(16) },
    meta: { marginTop: s(6) },
    actions: { flexDirection: 'row', gap: s(10), marginTop: s(14) },
    empty: { alignItems: 'center', paddingHorizontal: s(20) },
    emptyTitle: { marginTop: s(18) },
    emptyBody: { textAlign: 'center', marginTop: s(6) },
  });
}
