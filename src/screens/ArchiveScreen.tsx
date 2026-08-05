import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import { PipelineController } from '../pipeline/PipelineController';
import Icon from '../components/Icon';
import Mascot from '../components/Mascot';
import { confirmDestructive, quoted } from '../components/confirm';
import { IconButton, Pop, Raised, SoftButton, Txt } from '../components/ui';
import type { Meeting } from '../pipeline/types';
import { radius, s, sv, tilt, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Archive'>;

const when = (ts: number) =>
  ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

function dur(ms: number): string {
  if (!ms || ms <= 0) return '';
  const min = Math.round(ms / 60000);
  return min >= 1 ? `${min} min` : `${Math.max(1, Math.round(ms / 1000))}s`;
}

/**
 * Archived meetings: restore, or delete for good.
 *
 * Both actions are on the card rather than behind a long-press. The library hides its actions
 * because browsing is the common case there; here every row exists precisely to be acted on, so
 * hiding them behind a gesture would only add a step.
 */
export default function ArchiveScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<Meeting[]>([]);

  const load = useCallback(() => {
    db.listArchived().then(setItems).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    return navigation.addListener('focus', load);
  }, [navigation, load]);

  const restore = (m: Meeting) => db.setArchived(m.id, false).then(load).catch(() => {});

  const destroy = (m: Meeting) =>
    confirmDestructive({
      title: 'Delete this meeting?',
      message: `The recording, transcript and minutes for ${quoted(
        m.title,
      )} will be permanently deleted. This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: () => {
        PipelineController.deleteMeeting(m.id).then(load).catch(() => {});
      },
    });

  const deleteAll = () =>
    confirmDestructive({
      title: `Delete ${items.length} archived meeting${items.length === 1 ? '' : 's'}?`,
      message:
        'Every recording, transcript and set of minutes in the archive will be permanently ' +
        'deleted. This cannot be undone.',
      confirmLabel: 'Delete all',
      onConfirm: async () => {
        for (const m of items) {
          await PipelineController.deleteMeeting(m.id).catch(() => {});
        }
        load();
      },
    });

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <Txt variant="sectionTitle" style={st.flex}>
          Archived
        </Txt>
        {items.length > 0 ? (
          <SoftButton label="Delete all" icon="trash" tone={colors.danger} onPress={deleteAll} />
        ) : null}
      </View>

      <FlatList
        data={items}
        keyExtractor={m => m.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          st.listPad,
          { paddingBottom: insets.bottom + s(24) },
          items.length === 0 && st.emptyPad,
        ]}
        ListEmptyComponent={
          <View style={st.empty}>
            <Mascot mood="asleep" size={sv(120)} />
            <Txt variant="display" style={st.emptyTitle}>
              Nothing archived
            </Txt>
            <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
              Hold any meeting in the library to archive it. It stays on the device and can be
              brought back at any time.
            </Txt>
          </View>
        }
        renderItem={({ item, index }) => (
          <Pop index={index} style={st.rowWrap}>
            <Raised
              edge={colors.line}
              fill={colors.card}
              rad={radius.xl}
              depth={5}
              rotate={tilt(index)}
              onPress={() => navigation.navigate('Meeting', { meetingId: item.id })}>
              <View style={st.card}>
                <Txt variant="cardTitleSm" numberOfLines={2}>
                  {item.title || 'Untitled meeting'}
                </Txt>
                <Txt variant="chipSoft" color={colors.inkFaint} style={st.meta}>
                  {[when(item.createdAt), dur(item.durationMs)].filter(Boolean).join(' · ')}
                </Txt>
                <View style={st.actions}>
                  <SoftButton label="Restore" icon="restore" onPress={() => restore(item)} />
                  <SoftButton
                    label="Delete"
                    icon="trash"
                    tone={colors.danger}
                    onPress={() => destroy(item)}
                  />
                </View>
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
