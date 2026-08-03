import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, NativeEventEmitter, NativeModules } from 'react-native';
import ModelManager from '../native/NativeModelManager';
import Icon from '../components/Icon';
import { useTheme, spacing, radius, type Colors, type ThemeMode } from '../theme';

type Model = { id: string; name: string; installed: boolean; sizeBytes: number };

export default function SettingsScreen() {
  const { colors, mode, setMode } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [models, setModels] = useState<Model[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});

  const refresh = () => ModelManager.list().then(r => setModels(JSON.parse(r)));

  useEffect(() => {
    refresh();
    const emitter = new NativeEventEmitter(NativeModules.ModelManager);
    const sub = emitter.addListener('onModelProgress', (e: { id: string; downloaded: number; total: number }) => {
      const pct = e.total > 0 ? Math.round((e.downloaded / e.total) * 100) : 0;
      setProgress(p => ({ ...p, [e.id]: pct }));
    });
    return () => sub.remove();
  }, []);

  const onToggle = async (m: Model) => {
    if (m.installed) {
      await ModelManager.remove(m.id);
    } else {
      setProgress(p => ({ ...p, [m.id]: 0 }));
      try { await ModelManager.download(m.id); } catch {}
      setProgress(p => { const n = { ...p }; delete n[m.id]; return n; });
    }
    refresh();
  };

  const modes: { key: ThemeMode; label: string; icon: 'sun' | 'moon' | 'settings' }[] = [
    { key: 'light', label: 'Light', icon: 'sun' },
    { key: 'dark', label: 'Dark', icon: 'moon' },
    { key: 'system', label: 'Auto', icon: 'settings' },
  ];

  return (
    <ScrollView style={s.root} contentContainerStyle={{ padding: spacing.md }}>
      <Text style={s.section}>Appearance</Text>
      <View style={s.segment}>
        {modes.map(m => {
          const active = mode === m.key;
          return (
            <Pressable key={m.key} style={[s.segBtn, active && s.segBtnActive]} onPress={() => setMode(m.key)}>
              <Icon name={m.icon} size={16} color={active ? colors.onPrimary : colors.textDim} />
              <Text style={[s.segText, active && { color: colors.onPrimary }]}>{m.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={s.section}>Models</Text>
      {models.map(m => {
        const pct = progress[m.id];
        const downloading = pct !== undefined && !m.installed;
        return (
          <View key={m.id} style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{m.name}</Text>
              <Text style={s.meta}>{downloading ? `Downloading ${pct}%` : `${(m.sizeBytes / 1e6).toFixed(0)} MB`}</Text>
            </View>
            <Pressable
              style={[s.pill, m.installed ? s.pillRemove : s.pillGet]}
              onPress={() => onToggle(m)}
              disabled={downloading}>
              <Icon name={m.installed ? 'trash' : 'download'} size={16} color={m.installed ? colors.danger : colors.onPrimary} />
              <Text style={[s.pillText, { color: m.installed ? colors.danger : colors.onPrimary }]}>
                {m.installed ? 'Remove' : downloading ? '…' : 'Get'}
              </Text>
            </Pressable>
          </View>
        );
      })}

      <Text style={s.section}>Privacy</Text>
      <View style={s.privacy}>
        <Icon name="shield" size={20} color={colors.success} />
        <Text style={s.privacyText}>All processing is on-device. No third-party AI. No account required.</Text>
      </View>
    </ScrollView>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    section: { color: c.textDim, fontWeight: '800', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: spacing.lg, marginBottom: spacing.sm },
    segment: { flexDirection: 'row', backgroundColor: c.surfaceAlt, borderRadius: radius.md, padding: 4, gap: 4 },
    segBtn: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.sm, borderRadius: radius.sm },
    segBtnActive: { backgroundColor: c.primary },
    segText: { color: c.textDim, fontWeight: '700', fontSize: 13 },
    row: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, borderWidth: 1, borderColor: c.border },
    name: { color: c.text, fontWeight: '600' },
    meta: { color: c.textDim, fontSize: 12, marginTop: 2 },
    pill: { flexDirection: 'row', gap: 6, alignItems: 'center', borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    pillGet: { backgroundColor: c.primary },
    pillRemove: { backgroundColor: c.dangerSoft },
    pillText: { fontWeight: '700', fontSize: 13 },
    privacy: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', backgroundColor: c.successSoft, borderRadius: radius.md, padding: spacing.md },
    privacyText: { flex: 1, color: c.text, lineHeight: 20 },
  });
}
