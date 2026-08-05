import React, { useEffect, useMemo, useState } from 'react';
import { NativeEventEmitter, NativeModules, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import ModelManager from '../native/NativeModelManager';
import { db } from '../db/queries';
import Icon from '../components/Icon';
import { IconButton, Pop, ProgressBar, Raised, SectionRule, Switch, Txt } from '../components/ui';
import { radius, s, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;
type Model = { id: string; name: string; installed: boolean; sizeBytes: number };

/**
 * Open-source notices.
 *
 * MIT and Apache-2.0 both require the notice to travel with the software; redistributing weights
 * inside an APK counts, and the sherpa-onnx conversions we fetch carry no licence metadata of
 * their own. This screen is where that obligation is actually discharged — not decoration.
 */
const NOTICES: { name: string; licence: string; by: string }[] = [
  { name: 'Silero VAD', licence: 'MIT', by: 'Silero Team' },
  { name: 'Whisper (ggml)', licence: 'MIT', by: 'OpenAI / ggerganov' },
  { name: 'pyannote segmentation 3.0', licence: 'MIT', by: 'Hervé Bredin' },
  { name: '3D-Speaker CAM++', licence: 'Apache-2.0', by: 'Alibaba DAMO Academy' },
  { name: 'Qwen2.5 Instruct', licence: 'Apache-2.0', by: 'Alibaba Cloud' },
  { name: 'sherpa-onnx', licence: 'Apache-2.0', by: 'k2-fsa' },
  { name: 'Nunito', licence: 'SIL OFL 1.1', by: 'Vernon Adams / Cyreal' },
];

export default function SettingsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [models, setModels] = useState<Model[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [keepAudio, setKeepAudio] = useState(false);
  const [showNotices, setShowNotices] = useState(false);

  const refresh = () => ModelManager.list().then(r => setModels(JSON.parse(r)));

  useEffect(() => {
    db.getSetting('keepAudio')
      .then(v => setKeepAudio(v === '1'))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const emitter = new NativeEventEmitter(NativeModules.ModelManager);
    const sub = emitter.addListener(
      'onModelProgress',
      (e: { id: string; downloaded: number; total: number }) => {
        setProgress(p => ({ ...p, [e.id]: e.total > 0 ? Math.round((e.downloaded / e.total) * 100) : 0 }));
      },
    );
    return () => sub.remove();
  }, []);

  const onToggleKeepAudio = async () => {
    const next = !keepAudio;
    setKeepAudio(next);
    await db.setSetting('keepAudio', next ? '1' : '0');
  };

  const onToggle = async (m: Model) => {
    if (m.installed) await ModelManager.remove(m.id);
    else {
      setProgress(p => ({ ...p, [m.id]: 0 }));
      try {
        await ModelManager.download(m.id);
      } catch {}
      setProgress(p => {
        const n = { ...p };
        delete n[m.id];
        return n;
      });
    }
    refresh();
  };

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <Txt variant="sectionTitle">Settings</Txt>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[st.pad, { paddingBottom: insets.bottom + s(30) }]}>
        <View style={st.ruleWrap}>
          <SectionRule label="ON-DEVICE MODELS" />
        </View>

        <View style={st.list}>
          {models.map((m, i) => {
            const pct = progress[m.id];
            const busy = pct !== undefined && !m.installed;
            return (
              <Pop key={m.id} index={i}>
                <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
                  <View style={st.rowPad}>
                    <View style={st.row}>
                      <View style={st.flex}>
                        <Txt variant="bodyStrong">{m.name}</Txt>
                        <Txt variant="chip" color={colors.inkFaint} style={st.tiny}>
                          {busy ? `Downloading… ${pct}%` : `${(m.sizeBytes / 1e6).toFixed(0)} MB`}
                        </Txt>
                      </View>
                      <Pressable
                        onPress={() => onToggle(m)}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`${m.installed ? 'Remove' : 'Download'} ${m.name}`}
                        style={[st.pill, { backgroundColor: m.installed ? colors.dangerSoft : colors.primary }]}>
                        <Icon
                          name={m.installed ? 'trash' : 'download'}
                          size={s(15)}
                          color={m.installed ? colors.danger : colors.onPrimary}
                          strokeWidth={2.4}
                        />
                        <Txt variant="chip" color={m.installed ? colors.danger : colors.onPrimary}>
                          {m.installed ? 'Remove' : busy ? '…' : 'Get'}
                        </Txt>
                      </Pressable>
                    </View>
                    {busy ? (
                      <View style={st.tiny}>
                        <ProgressBar pct={pct} color={colors.primary} track={colors.cardAlt} />
                      </View>
                    ) : null}
                  </View>
                </Raised>
              </Pop>
            );
          })}
        </View>

        <View style={st.ruleWrap}>
          <SectionRule label="PRIVACY" />
        </View>
        <View style={st.list}>
          <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5} onPress={onToggleKeepAudio}>
            <View style={[st.rowPad, st.row]}>
              <View style={st.flex}>
                <Txt variant="bodyStrong">Keep audio after transcribing</Txt>
                <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                  {keepAudio
                    ? 'Recordings stay on the device (~115 MB/hour) so a meeting can be reprocessed.'
                    : 'Recordings are deleted once transcribed. Transcript and minutes are kept, encrypted.'}
                </Txt>
              </View>
              <Switch on={keepAudio} onToggle={onToggleKeepAudio} />
            </View>
          </Raised>

          <View style={st.assure}>
            <Icon name="shield" size={s(20)} color={colors.success} strokeWidth={2.4} />
            <Txt variant="chip" color={colors.ink} style={st.flex}>
              Everything runs on this device. No third-party AI, no account, nothing uploaded.
            </Txt>
          </View>
        </View>

        <View style={st.ruleWrap}>
          <SectionRule label="ABOUT" />
        </View>
        <View style={st.list}>
          <Raised
            edge={colors.line}
            fill={colors.card}
            rad={radius.xl}
            depth={5}
            onPress={() => setShowNotices(v => !v)}>
            <View style={st.rowPad}>
              <View style={st.row}>
                <View style={st.flex}>
                  <Txt variant="bodyStrong">Open-source notices</Txt>
                  <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                    The models and type this app is built on
                  </Txt>
                </View>
                <Icon
                  name={showNotices ? 'chevronUp' : 'chevronDown'}
                  size={s(18)}
                  color={colors.inkFaint}
                  strokeWidth={2.4}
                />
              </View>
              {showNotices ? (
                <View style={st.notices}>
                  {NOTICES.map(n => (
                    // Stacked, not name-left/licence-right: side by side the longest pairs clip
                    // mid-word, and the licence is the part that legally has to be readable.
                    <View key={n.name} style={st.notice}>
                      <Txt variant="chip">{n.name}</Txt>
                      <Txt variant="chip" color={colors.inkFaint}>
                        {n.by} · {n.licence}
                      </Txt>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          </Raised>
        </View>
      </ScrollView>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20) },
    pad: { paddingTop: s(6) },
    ruleWrap: { marginHorizontal: s(20), marginTop: s(22), marginBottom: s(10) },
    list: { paddingHorizontal: s(20), gap: s(10) },
    rowPad: { padding: s(16) },
    row: { flexDirection: 'row', alignItems: 'center', gap: s(12) },
    tiny: { marginTop: s(4) },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(6),
      borderRadius: radius.pill,
      paddingHorizontal: s(14),
      paddingVertical: s(8),
    },
    assure: {
      flexDirection: 'row',
      gap: s(12),
      alignItems: 'center',
      backgroundColor: c.successSoft,
      borderRadius: radius.xl,
      padding: s(16),
    },
    notices: { marginTop: s(14), gap: s(10) },
    notice: { gap: 1 },
  });
}
