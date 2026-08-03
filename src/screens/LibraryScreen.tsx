import React, { useEffect, useMemo } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, Alert } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useLibraryStore } from '../state/libraryStore';
import { PipelineController } from '../pipeline/PipelineController';
import Overlay from '../native/NativeOverlay';
import Icon, { type IconName } from '../components/Icon';
import { useTheme, spacing, radius, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Library'>;

function statusColor(status: string, c: Colors): string {
  if (status === 'done') return c.success;
  if (status === 'error') return c.danger;
  if (status === 'recording' || status === 'captured') return c.warning;
  return c.primary; // vad / asr / diarized (processing)
}

export default function LibraryScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { meetings, refresh } = useLibraryStore();

  useEffect(() => {
    const onFocus = () => {
      refresh();
      PipelineController.processPending().then(refresh).catch(() => {});
    };
    onFocus();
    return navigation.addListener('focus', onFocus);
  }, [navigation, refresh]);

  const enableFloating = async () => {
    if (!(await Overlay.hasPermission())) {
      Alert.alert(
        'Allow floating recorder',
        'AudioNotes needs "display over other apps" so the recorder bubble can float on top of other apps and keep recording with the screen off.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open settings', onPress: () => Overlay.requestPermission() },
        ],
      );
      return;
    }
    await Overlay.show();
    Alert.alert('Floating recorder on', 'Tap the bubble to start/stop. Drag to move it.');
  };

  const BarButton = ({ icon, label, onPress, primary }: { icon: IconName; label: string; onPress: () => void; primary?: boolean }) => (
    <Pressable style={[s.barBtn, primary && s.barBtnPrimary]} onPress={onPress}>
      <Icon name={icon} size={22} color={primary ? colors.onPrimary : colors.textDim} />
      <Text style={[s.barText, primary && { color: colors.onPrimary }]}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={s.root}>
      <FlatList
        data={meetings}
        keyExtractor={m => m.id}
        contentContainerStyle={meetings.length === 0 && { flex: 1, justifyContent: 'center' }}
        ListEmptyComponent={
          <View style={s.emptyWrap}>
            <View style={s.emptyIcon}>
              <Icon name="mic" size={34} color={colors.primary} />
            </View>
            <Text style={s.emptyTitle}>No meetings yet</Text>
            <Text style={s.empty}>
              Tap Record to capture your first meeting. Turn on the floating recorder to keep recording
              while you use other apps or with the screen off.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable style={s.row} onPress={() => navigation.navigate('Meeting', { meetingId: item.id })}>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>{item.title || 'Untitled meeting'}</Text>
              <View style={s.statusRow}>
                <View style={[s.statusDot, { backgroundColor: statusColor(item.status, colors) }]} />
                <Text style={s.meta}>{item.status}</Text>
              </View>
            </View>
            <Icon name="chevronRight" size={20} color={colors.textFaint} />
          </Pressable>
        )}
      />
      <View style={s.bar}>
        <BarButton icon="search" label="Search" onPress={() => navigation.navigate('Search')} />
        <BarButton icon="plus" label="Float" onPress={enableFloating} />
        <BarButton icon="mic" label="Record" primary onPress={() => navigation.navigate('Record')} />
        <BarButton icon="settings" label="Settings" onPress={() => navigation.navigate('Settings')} />
      </View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, padding: spacing.md, backgroundColor: c.bg },
    emptyWrap: { alignItems: 'center', paddingHorizontal: spacing.lg, gap: spacing.sm },
    emptyIcon: { width: 76, height: 76, borderRadius: 38, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
    emptyTitle: { color: c.text, fontSize: 18, fontWeight: '800' },
    empty: { color: c.textDim, textAlign: 'center', lineHeight: 21 },
    row: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, borderWidth: 1, borderColor: c.border },
    title: { color: c.text, fontSize: 16, fontWeight: '700' },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 6 },
    statusDot: { width: 8, height: 8, borderRadius: 4 },
    meta: { color: c.textDim, fontSize: 12, textTransform: 'capitalize' },
    bar: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm },
    barBtn: { flex: 1, backgroundColor: c.surface, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center', gap: 4, borderWidth: 1, borderColor: c.border },
    barBtnPrimary: { backgroundColor: c.primary, borderColor: c.primary },
    barText: { color: c.textDim, fontWeight: '700', fontSize: 11 },
  });
}
