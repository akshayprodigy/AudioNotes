import React, { useEffect, useMemo, useState } from 'react';
import {
  NativeEventEmitter,
  NativeModules,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import ModelManager from '../native/NativeModelManager';
import { db } from '../db/queries';
import Icon from '../components/Icon';
import { Card, FadeIn, ProgressBar, SectionLabel, Txt } from '../components/ui';
import { radius, spacing, useTheme, type Colors } from '../theme';

type Model = { id: string; name: string; installed: boolean; sizeBytes: number };

/**
 * Open-source notices.
 *
 * Every model here ships under a permissive licence, and MIT and Apache-2.0 both require the
 * notice to travel with the software. Redistributing the weights inside an APK counts, and the
 * sherpa-onnx conversions we fetch carry no licence metadata of their own — so this screen is
 * where the obligation is actually discharged. Do not delete it to save space.
 */
const NOTICES: { name: string; licence: string; by: string }[] = [
  { name: 'Silero VAD', licence: 'MIT', by: 'Silero Team' },
  { name: 'Whisper (ggml)', licence: 'MIT', by: 'OpenAI / ggerganov' },
  { name: 'pyannote segmentation 3.0', licence: 'MIT', by: 'Hervé Bredin' },
  { name: '3D-Speaker CAM++', licence: 'Apache-2.0', by: 'Alibaba DAMO Academy' },
  { name: 'Qwen2.5 Instruct', licence: 'Apache-2.0', by: 'Alibaba Cloud' },
  { name: 'sherpa-onnx', licence: 'Apache-2.0', by: 'k2-fsa' },
  { name: 'Poppins', licence: 'SIL OFL 1.1', by: 'Indian Type Foundry' },
];

export default function SettingsScreen() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
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

  const onToggleKeepAudio = async () => {
    const next = !keepAudio;
    setKeepAudio(next);
    await db.setSetting('keepAudio', next ? '1' : '0');
  };

  useEffect(() => {
    refresh();
    const emitter = new NativeEventEmitter(NativeModules.ModelManager);
    const sub = emitter.addListener(
      'onModelProgress',
      (e: { id: string; downloaded: number; total: number }) => {
        const pct = e.total > 0 ? Math.round((e.downloaded / e.total) * 100) : 0;
        setProgress(p => ({ ...p, [e.id]: pct }));
      },
    );
    return () => sub.remove();
  }, []);

  const onToggle = async (m: Model) => {
    if (m.installed) {
      await ModelManager.remove(m.id);
    } else {
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
    <ScrollView
      style={s.root}
      contentContainerStyle={s.pad}
      showsVerticalScrollIndicator={false}>
      <SectionLabel>On-device models</SectionLabel>
      {models.map((m, i) => {
        const pct = progress[m.id];
        const downloading = pct !== undefined && !m.installed;
        return (
          <FadeIn key={m.id} index={i} style={s.gapSm}>
            <Card>
              <View style={s.row}>
                <View style={s.rowFill}>
                  <Txt variant="bodyStrong">{m.name}</Txt>
                  <Txt variant="caption" color={colors.inkFaint}>
                    {downloading ? `Downloading… ${pct}%` : `${(m.sizeBytes / 1e6).toFixed(0)} MB`}
                  </Txt>
                </View>
                <Pressable
                  onPress={() => onToggle(m)}
                  disabled={downloading}
                  accessibilityRole="button"
                  accessibilityLabel={`${m.installed ? 'Remove' : 'Download'} ${m.name}`}
                  style={[s.pill, m.installed ? s.pillRemove : s.pillGet]}>
                  <Icon
                    name={m.installed ? 'trash' : 'download'}
                    size={15}
                    color={m.installed ? colors.danger : colors.onPrimary}
                  />
                  <Txt variant="caption" color={m.installed ? colors.danger : colors.onPrimary}>
                    {m.installed ? 'Remove' : downloading ? '…' : 'Get'}
                  </Txt>
                </Pressable>
              </View>
              {downloading ? (
                <View style={s.gapSm}>
                  <ProgressBar pct={pct} />
                </View>
              ) : null}
            </Card>
          </FadeIn>
        );
      })}

      <View style={s.sectionGap}>
        <SectionLabel>Privacy</SectionLabel>
      </View>
      <Card onPress={onToggleKeepAudio}>
        <View style={s.row}>
          <View style={s.rowFill}>
            <Txt variant="bodyStrong">Keep audio after transcribing</Txt>
            <Txt variant="caption" color={colors.inkSoft} style={s.gapXs}>
              {keepAudio
                ? 'Recordings stay on the device (~115 MB/hour) so a meeting can be reprocessed later.'
                : 'Recordings are deleted once transcribed. The transcript and minutes are kept, encrypted.'}
            </Txt>
          </View>
          <View style={[s.switch, keepAudio && s.switchOn]}>
            <View style={[s.knob, keepAudio && s.knobOn]} />
          </View>
        </View>
      </Card>

      <View style={s.assure}>
        <Icon name="shield" size={20} color={colors.success} />
        <Txt variant="caption" color={colors.ink} style={s.rowFill}>
          Everything runs on this device. No third-party AI, no account, nothing uploaded.
        </Txt>
      </View>

      <View style={s.sectionGap}>
        <SectionLabel>About</SectionLabel>
      </View>
      <Card onPress={() => setShowNotices(v => !v)}>
        <View style={s.row}>
          <View style={s.rowFill}>
            <Txt variant="bodyStrong">Open-source notices</Txt>
            <Txt variant="caption" color={colors.inkSoft} style={s.gapXs}>
              The models and type this app is built on
            </Txt>
          </View>
          <Icon
            name={showNotices ? 'chevronRight' : 'chevronRight'}
            size={18}
            color={colors.inkFaint}
          />
        </View>
        {showNotices ? (
          <View style={s.notices}>
            {NOTICES.map(n => (
              <View key={n.name} style={s.notice}>
                <Txt variant="caption">{n.name}</Txt>
                <Txt variant="caption" color={colors.inkFaint}>
                  {n.by} · {n.licence}
                </Txt>
              </View>
            ))}
          </View>
        ) : null}
      </Card>
    </ScrollView>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    pad: { padding: spacing.xl, paddingBottom: spacing.xxl },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    rowFill: { flex: 1 },
    gapSm: { marginTop: spacing.sm },
    gapXs: { marginTop: 2 },
    sectionGap: { marginTop: spacing.xl },
    pill: {
      flexDirection: 'row',
      gap: 6,
      alignItems: 'center',
      borderRadius: radius.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    pillGet: { backgroundColor: c.primary },
    pillRemove: { backgroundColor: c.dangerSoft },
    switch: {
      width: 48,
      height: 28,
      borderRadius: 14,
      backgroundColor: c.lineStrong,
      padding: 3,
      justifyContent: 'center',
    },
    switchOn: { backgroundColor: c.primary },
    knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: c.card },
    knobOn: { alignSelf: 'flex-end' },
    assure: {
      flexDirection: 'row',
      gap: spacing.md,
      alignItems: 'center',
      backgroundColor: c.successSoft,
      borderRadius: radius.lg,
      padding: spacing.lg,
      marginTop: spacing.md,
    },
    notices: { marginTop: spacing.md, gap: spacing.sm },
    notice: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: spacing.md,
    },
  });
}
