import React, { useEffect, useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useLibraryStore } from '../state/libraryStore';
import { PipelineController } from '../pipeline/PipelineController';
import Icon, { type IconName } from '../components/Icon';
import Mascot from '../components/Mascot';
import { Card, Chip, FadeIn, LiveDot, Txt } from '../components/ui';
import { radius, spacing, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Library'>;

type Row = { id: string; title: string; createdAt: number; durationMs: number; status: string };

/**
 * Status is the one thing a row must communicate instantly, so each state gets its own colour,
 * icon and plain-English label. "Vad"/"Asr"/"Diarized" leaked pipeline vocabulary into the UI —
 * nobody outside this codebase knows what a VAD is, and "Error" told a user whose recording was
 * simply silent nothing they could act on.
 */
function statusOf(status: string, c: Colors) {
  switch (status) {
    case 'done':
      return { label: 'Ready', color: c.success, soft: c.successSoft, icon: 'check' as IconName };
    case 'error':
      return {
        label: 'No speech found',
        color: c.inkSoft,
        soft: c.cardAlt,
        icon: 'alert' as IconName,
      };
    case 'recording':
      return { label: 'Recording', color: c.danger, soft: c.dangerSoft, icon: 'mic' as IconName };
    case 'captured':
      return { label: 'Queued', color: c.warning, soft: c.warningSoft, icon: 'clock' as IconName };
    default:
      // vad / asr / diarized — all "we are working on it" as far as the user is concerned.
      return {
        label: 'Transcribing',
        color: c.primary,
        soft: c.primarySoft,
        icon: 'clock' as IconName,
      };
  }
}

function when(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yst = new Date(now);
  yst.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  if (d.toDateString() === yst.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

function duration(ms: number): string {
  if (!ms || ms <= 0) return '';
  const min = Math.round(ms / 60000);
  return min >= 1 ? `${min} min` : `${Math.max(1, Math.round(ms / 1000))}s`;
}

export default function LibraryScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { meetings, refresh } = useLibraryStore();
  // This screen hides the stack header to draw its own large title, which also means nothing is
  // reserving the status-bar area for it. Without this the title sits under the clock.
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const onFocus = () => {
      refresh();
      PipelineController.processPending().then(refresh).catch(() => {});
    };
    onFocus();
    return navigation.addListener('focus', onFocus);
  }, [navigation, refresh]);

  const busy = meetings.filter(m => !['done', 'error'].includes(m.status)).length;

  const renderItem = ({ item, index }: { item: Row; index: number }) => {
    const st = statusOf(item.status, colors);
    const live = !['done', 'error'].includes(item.status);
    return (
      <FadeIn index={index} style={s.rowWrap}>
        <Card accent={st.color} onPress={() => navigation.navigate('Meeting', { meetingId: item.id })}>
          <View style={s.rowTop}>
            <View style={s.rowFill}>
              <Txt variant="heading" numberOfLines={2}>
                {item.title || 'Untitled meeting'}
              </Txt>
              <View style={s.metaRow}>
                <Txt variant="caption" color={colors.inkFaint}>
                  {when(item.createdAt)}
                </Txt>
                {duration(item.durationMs) ? (
                  <>
                    <View style={s.dot} />
                    <Txt variant="caption" color={colors.inkFaint}>
                      {duration(item.durationMs)}
                    </Txt>
                  </>
                ) : null}
              </View>
            </View>
            <Icon name="chevronRight" size={18} color={colors.inkFaint} />
          </View>
          <View style={s.chipRow}>
            {live ? (
              <View style={[s.liveChip, { backgroundColor: st.soft }]}>
                <LiveDot color={st.color} size={7} />
                <Txt variant="caption" color={st.color}>
                  {st.label}
                </Txt>
              </View>
            ) : (
              <Chip label={st.label} color={st.color} soft={st.soft} icon={st.icon} />
            )}
          </View>
        </Card>
      </FadeIn>
    );
  };

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + spacing.md }]}>
        <View style={s.rowFill}>
          <Txt variant="display">Meetings</Txt>
          <Txt variant="body" color={colors.inkSoft}>
            {meetings.length === 0
              ? 'Nothing recorded yet'
              : busy > 0
              ? `${meetings.length} saved · ${busy} in progress`
              : `${meetings.length} saved`}
          </Txt>
        </View>
        <Pressable
          style={s.iconBtn}
          onPress={() => navigation.navigate('Search')}
          accessibilityRole="button"
          accessibilityLabel="Search meetings">
          <Icon name="search" size={20} color={colors.inkSoft} />
        </Pressable>
        <Pressable
          style={s.iconBtn}
          onPress={() => navigation.navigate('Settings')}
          accessibilityRole="button"
          accessibilityLabel="Settings">
          <Icon name="settings" size={20} color={colors.inkSoft} />
        </Pressable>
      </View>

      <FlatList
        data={meetings as Row[]}
        keyExtractor={m => m.id}
        renderItem={renderItem}
        contentContainerStyle={[
          s.listPad,
          meetings.length === 0 && { flexGrow: 1, justifyContent: 'center' },
        ]}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <FadeIn style={s.empty}>
            <Mascot mood="asleep" size={150} />
            <Txt variant="title" style={s.emptyTitle}>
              No meetings yet
            </Txt>
            <Txt variant="body" color={colors.inkSoft} style={s.emptyBody}>
              Tap record and Pip will listen, write the transcript, and pull out who said what.
              Everything stays on your phone.
            </Txt>
          </FadeIn>
        }
      />

      {/* One primary action, floating clear of the list. The old bar had four equal-weight buttons
          including a "Float" toggle the app now handles automatically when you switch away. */}
      <View
        style={[s.fabWrap, { bottom: Math.max(insets.bottom, spacing.md) + spacing.md }]}
        pointerEvents="box-none">
        <Pressable
          onPress={() => navigation.navigate('Record')}
          accessibilityRole="button"
          accessibilityLabel="Record a meeting"
          style={s.fabOuter}>
          <View style={s.fab}>
            <Icon name="mic" size={22} color={colors.onPrimary} />
            <Txt variant="label" color={colors.onPrimary}>
              Record
            </Txt>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.lg,
      paddingBottom: spacing.md,
    },
    rowFill: { flex: 1 },
    iconBtn: {
      width: 42,
      height: 42,
      borderRadius: radius.md,
      backgroundColor: c.card,
      borderWidth: 1,
      borderColor: c.line,
      alignItems: 'center',
      justifyContent: 'center',
    },
    listPad: { paddingHorizontal: spacing.xl, paddingBottom: 120 },
    rowWrap: { marginBottom: spacing.md },
    rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 3 },
    dot: { width: 3, height: 3, borderRadius: 2, backgroundColor: c.inkFaint },
    chipRow: { flexDirection: 'row', marginTop: spacing.md },
    liveChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.pill,
    },
    empty: { alignItems: 'center', paddingHorizontal: spacing.lg },
    emptyTitle: { marginTop: spacing.lg },
    emptyBody: { textAlign: 'center', marginTop: spacing.sm },
    fabWrap: { position: 'absolute', left: 0, right: 0, bottom: spacing.xl, alignItems: 'center' },
    fabOuter: { borderRadius: radius.pill, backgroundColor: c.primaryEdge, paddingBottom: 4 },
    fab: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.primary,
      paddingHorizontal: spacing.xxl,
      paddingVertical: 15,
      borderRadius: radius.pill,
    },
  });
}
