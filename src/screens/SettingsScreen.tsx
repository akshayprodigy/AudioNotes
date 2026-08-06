import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, AppState, NativeEventEmitter, NativeModules, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import ModelManager from '../native/NativeModelManager';
import Overlay from '../native/NativeOverlay';
import { db } from '../db/queries';
import { PipelineController } from '../pipeline/PipelineController';
import Icon from '../components/Icon';
import { confirmDestructive } from '../components/confirm';
import { IconButton, Pop, ProgressBar, Raised, SectionRule, Switch, Txt } from '../components/ui';
import { radius, s, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;
type Model = {
  id: string;
  name: string;
  purpose: string;
  detail: string;
  required: boolean;
  installed: boolean;
  sizeBytes: number;
};

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;

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
  const [empties, setEmpties] = useState(0);
  const [floatOn, setFloatOn] = useState(false);

  const refresh = () => ModelManager.list().then(r => setModels(JSON.parse(r)));

  const countEmpties = useCallback(() => {
    db.emptyMeetings()
      .then(r => setEmpties(r.length))
      .catch(() => {});
  }, []);

  // Re-read on focus, not just on mount: granting the overlay permission takes the user out to a
  // system screen, so the only reliable moment to learn the answer is when they come back.
  const syncFloat = useCallback(async () => {
    const [granted, want] = await Promise.all([
      Overlay.hasPermission().catch(() => false),
      db.getSetting('floatEnabled').catch(() => null),
    ]);
    setFloatOn(granted && want !== '0');
    if (granted && want === null) db.setSetting('floatEnabled', '1').catch(() => {});
  }, []);

  useEffect(() => {
    db.getSetting('keepAudio')
      .then(v => setKeepAudio(v === '1'))
      .catch(() => {});
    countEmpties();
    syncFloat();
    const offFocus = navigation.addListener('focus', () => {
      countEmpties();
      syncFloat();
    });
    // AppState as well as navigation focus. Granting the overlay permission sends the user to a
    // SYSTEM settings screen — a different app — so this screen is never unfocused in React
    // Navigation's terms and 'focus' does not fire on the way back. On focus alone the toggle
    // stayed off after the user had just granted it, which reads as the switch being broken.
    const sub = AppState.addEventListener('change', a => {
      if (a === 'active') syncFloat();
    });
    return () => {
      offFocus();
      sub.remove();
    };
  }, [navigation, countEmpties, syncFloat]);

  /**
   * Bulk-delete the mis-taps. Sequential rather than Promise.all: each one cancels native work
   * and unlinks a file, and firing twenty of those at the pipeline at once is a good way to race
   * the capture service for no gain on a list this size.
   */
  const clearEmpties = () =>
    confirmDestructive({
      title: `Delete ${empties} empty recording${empties === 1 ? '' : 's'}?`,
      message:
        'These recordings produced no transcript, so only the audio will be lost. This cannot ' +
        'be undone.',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        const rows = await db.emptyMeetings().catch(() => []);
        for (const r of rows) {
          await PipelineController.deleteMeeting(r.id).catch(() => {});
        }
        countEmpties();
      },
    });

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

  /**
   * The permission lives in a system settings screen the user has to visit and come back from, so
   * this cannot be a plain toggle: we send them there, then re-read on focus (see the listener in
   * the effect above) rather than assuming they granted it.
   */
  const onToggleFloat = async () => {
    if (floatOn) {
      setFloatOn(false);
      await db.setSetting('floatEnabled', '0');
      Overlay.hide().catch(() => {});
      return;
    }
    if (!(await Overlay.hasPermission().catch(() => false))) {
      Alert.alert(
        'Let Pip float on top?',
        'Android needs permission to draw over other apps. We only ever draw the small recorder ' +
          'control, and only while a meeting is running.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open settings', onPress: () => Overlay.requestPermission().catch(() => {}) },
        ],
      );
      return;
    }
    setFloatOn(true);
    await db.setSetting('floatEnabled', '1');
  };

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
                    {/* The job first, the model name after. Someone deciding whether they can
                        free up 190 MB is served by "writes down what was said, more accurately",
                        not by "Whisper small (q5_1)" — but the name still has to be here, because
                        it is what makes the open-source notices and the privacy claim checkable. */}
                    <View style={st.row}>
                      <View style={st.flex}>
                        <Txt variant="bodyStrong">{m.purpose}</Txt>
                        <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                          {m.detail}
                        </Txt>
                      </View>
                      <Pressable
                        onPress={() => onToggle(m)}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`${m.installed ? 'Remove' : 'Download'} ${m.purpose} (${m.name})`}
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

                    <View style={st.modelMeta}>
                      <View style={[st.tag, { backgroundColor: m.required ? colors.primarySoft : colors.cardAlt }]}>
                        <Txt variant="chipSm" color={m.required ? colors.primary : colors.inkFaint}>
                          {m.required ? 'REQUIRED' : 'OPTIONAL'}
                        </Txt>
                      </View>
                      <Txt variant="chipSoft" color={colors.inkFaint}>
                        {m.name} · {busy ? `downloading ${pct}%` : mb(m.sizeBytes)}
                      </Txt>
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
          <SectionRule label="WHILE YOU RECORD" />
        </View>
        <View style={st.list}>
          {/* The only route to the "display over other apps" permission.
              It went missing when the Library was rebuilt — the redesign dropped the old header's
              Float button and nothing replaced it, so the bubble could never be switched on again
              on a fresh install and the whole feature was unreachable. */}
          <Raised
            edge={colors.line}
            fill={colors.card}
            rad={radius.xl}
            depth={5}
            onPress={onToggleFloat}>
            <View style={[st.rowPad, st.row]}>
              <View style={st.flex}>
                <Txt variant="bodyStrong">Floating recorder</Txt>
                <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                  {floatOn
                    ? 'Pip floats on top of other apps while you record, so you can pause or stop without coming back here.'
                    : 'Show a small floating control on top of other apps while recording. Needs permission to draw over other apps.'}
                </Txt>
              </View>
              <Switch on={floatOn} onToggle={onToggleFloat} />
            </View>
          </Raised>
        </View>

        <View style={st.ruleWrap}>
          <SectionRule label="LIBRARY" />
        </View>
        <View style={st.list}>
          <Raised
            edge={colors.line}
            fill={colors.card}
            rad={radius.xl}
            depth={5}
            onPress={empties > 0 ? clearEmpties : undefined}>
            <View style={[st.rowPad, st.row]}>
              <View style={st.flex}>
                <Txt variant="bodyStrong">Clear empty recordings</Txt>
                <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                  {empties > 0
                    ? `${empties} recording${empties === 1 ? '' : 's'} produced no speech. Deleting them frees the space and tidies the library.`
                    : 'Nothing to clear — every meeting in your library has a transcript.'}
                </Txt>
              </View>
              {empties > 0 ? (
                <View style={[st.pill, { backgroundColor: colors.dangerSoft }]}>
                  <Icon name="trash" size={s(15)} color={colors.danger} strokeWidth={2.4} />
                  <Txt variant="chip" color={colors.danger}>
                    {empties}
                  </Txt>
                </View>
              ) : null}
            </View>
          </Raised>

          <Raised
            edge={colors.line}
            fill={colors.card}
            rad={radius.xl}
            depth={5}
            onPress={() => navigation.navigate('Archive')}>
            <View style={[st.rowPad, st.row]}>
              <View style={st.flex}>
                <Txt variant="bodyStrong">Archived meetings</Txt>
                <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                  Hidden from the library, still on the device. Restore or delete them here.
                </Txt>
              </View>
              <Icon name="chevronRight" size={s(18)} color={colors.inkFaint} strokeWidth={2.4} />
            </View>
          </Raised>
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
    modelMeta: { flexDirection: 'row', alignItems: 'center', gap: s(8), marginTop: s(12) },
    tag: { paddingHorizontal: s(8), paddingVertical: s(4), borderRadius: radius.pill },
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
