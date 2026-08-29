import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  NativeEventEmitter,
  NativeModules,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import ModelManager from '../native/NativeModelManager';
import { db } from '../db/queries';
import { PipelineController } from '../pipeline/PipelineController';
import Icon from '../components/Icon';
import { confirmDestructive } from '../components/confirm';
import { IconButton, Pop, ProgressBar, Raised, SectionRule, SoftButton, Switch, Txt } from '../components/ui';
import Backup from '../native/NativeBackup';
import Licence, { type LicenceStatus } from '../native/NativeLicence';
import { signIn, signOut } from '../billing/subscription';
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
  needsSubscription: boolean;
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
  // Subscription. The app never advertises a price or links to a checkout — it signs in, and
  // buying happens on the web. That separation is deliberate; see the licence server's README.
  const [lic, setLic] = React.useState<LicenceStatus | null>(null);
  const [licEmail, setLicEmail] = React.useState('');
  const [licPass, setLicPass] = React.useState('');
  const [licBusy, setLicBusy] = React.useState(false);
  const [signedInAs, setSignedInAs] = React.useState<string | null>(null);
  const [hasServer, setHasServer] = React.useState(false);

  const refreshLicence = React.useCallback(async () => {
    try {
      const [status, base, key] = await Promise.all([
        Licence.status(),
        Licence.baseUrl(),
        Licence.refreshKey(),
      ]);
      setLic(status);
      setHasServer(Boolean(base));
      // A stored refresh key is what "signed in" means here; the email is only remembered for
      // the label, so an empty one still counts.
      if (key) setSignedInAs(prev => prev ?? 'this device');
    } catch {
      // A licence that cannot be read is not worth interrupting Settings for.
    }
  }, []);

  React.useEffect(() => {
    refreshLicence();
  }, [refreshLicence]);

  const onSignIn = React.useCallback(async () => {
    setLicBusy(true);
    try {
      const res = await signIn(licEmail, licPass);
      setSignedInAs(res.email);
      setLicPass('');
      await refreshLicence();
      if (!res.paid) {
        Alert.alert(
          'Signed in',
          'This account does not have a subscription yet. Everything except the written summary keeps working.',
        );
      }
    } catch (e: any) {
      Alert.alert('Could not sign in', String(e?.message ?? e));
    } finally {
      setLicBusy(false);
    }
  }, [licEmail, licPass, refreshLicence]);

  const onSignOut = React.useCallback(async () => {
    await signOut();
    setSignedInAs(null);
    await refreshLicence();
  }, [refreshLicence]);

  // Backup lives entirely in this screen: a passphrase the user types, and two calls.
  const [pass, setPass] = React.useState('');
  const [busy, setBusy] = React.useState<'export' | 'restore' | null>(null);

  const onBackup = React.useCallback(async () => {
    setBusy('export');
    try {
      const name = await Backup.exportAndShare(pass);
      // The share sheet is already open by now; this is what to do with what it hands over.
      Alert.alert('Backup ready', `${name} — save it somewhere you will still have it when this phone is gone.`);
    } catch (e: any) {
      Alert.alert('Could not back up', String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [pass]);

  const onRestore = React.useCallback(async () => {
    setBusy('restore');
    try {
      const count = await Backup.pickAndRestore(pass);
      // null means the picker was dismissed, which is a choice, not a failure.
      if (count !== null) {
        Alert.alert(
          'Restored',
          count === 1 ? '1 meeting is back.' : `${count} meetings are back.`,
        );
      }
    } catch (e: any) {
      Alert.alert('Could not restore', String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [pass]);

  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [models, setModels] = useState<Model[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [keepAudio, setKeepAudio] = useState(false);
  const [showNotices, setShowNotices] = useState(false);
  const [empties, setEmpties] = useState(0);

  const refresh = () => ModelManager.list().then(r => setModels(JSON.parse(r)));

  const countEmpties = useCallback(() => {
    db.emptyMeetings()
      .then(r => setEmpties(r.length))
      .catch(() => {});
  }, []);

  useEffect(() => {
    db.getSetting('keepAudio')
      .then(v => setKeepAudio(v === '1'))
      .catch(() => {});
    countEmpties();
    const offFocus = navigation.addListener('focus', () => {
      countEmpties();
    });
    return () => {
      offFocus();
    };
  }, [navigation, countEmpties]);

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

  const onToggleKeepAudio = async () => {
    const next = !keepAudio;
    setKeepAudio(next);
    await db.setSetting('keepAudio', next ? '1' : '0');
  };

  const onToggle = async (m: Model) => {
    // Removing is always allowed, including for a model bought and then cancelled: it is their
    // storage. Adding one is what the subscription gates.
    if (m.installed) {
      await ModelManager.remove(m.id);
      refresh();
      return;
    }
    if (m.needsSubscription && !lic?.paid) {
      // ModelManager.download would refuse this anyway — that refusal is the enforcement. Saying
      // so here is what stops the tap looking broken. The old code swallowed the error entirely,
      // so the button did nothing and explained nothing.
      Alert.alert(
        `${m.name} is part of the subscription`,
        'Sign in with a subscribed account and it will download. Everything else in the app ' +
          'works without it.',
      );
      return;
    }
    setProgress(p => ({ ...p, [m.id]: 0 }));
    try {
      await ModelManager.download(m.id);
    } catch (e: any) {
      Alert.alert('Could not download', String(e?.message ?? e));
    } finally {
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
                      <View
                        style={[
                          st.tag,
                          {
                            backgroundColor: m.needsSubscription
                              ? colors.successSoft
                              : m.required
                                ? colors.primarySoft
                                : colors.cardAlt,
                          },
                        ]}>
                        <Txt
                          variant="chipSm"
                          color={
                            m.needsSubscription
                              ? colors.success
                              : m.required
                                ? colors.primary
                                : colors.inkFaint
                          }>
                          {m.needsSubscription ? 'PRO' : m.required ? 'REQUIRED' : 'OPTIONAL'}
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
          <SectionRule label="SUBSCRIPTION" />
        </View>
        <View style={st.list}>
          <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
            <View style={st.rowPad}>
              <Txt variant="bodyStrong">
                {lic?.paid ? 'Pro' : 'Free'}
              </Txt>
              <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                {lic?.paid
                  ? 'The summary and the written minutes are on. Everything runs on this phone.'
                  : 'Recording, transcripts and rule-based minutes are free forever. The written summary needs a subscription.'}
              </Txt>

              {!hasServer ? (
                <Txt variant="chip" color={colors.inkFaint} style={st.tiny}>
                  This build has no licence server configured.
                </Txt>
              ) : signedInAs ? (
                <View style={st.backupRow}>
                  <View style={st.flex}>
                    <SoftButton icon="x" label="Sign out" onPress={onSignOut} />
                  </View>
                </View>
              ) : (
                <>
                  <TextInput
                    style={[st.pass, { borderColor: colors.line, color: colors.ink }]}
                    value={licEmail}
                    onChangeText={setLicEmail}
                    placeholder="Email"
                    placeholderTextColor={colors.inkFaint}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TextInput
                    style={[st.pass, { borderColor: colors.line, color: colors.ink }]}
                    value={licPass}
                    onChangeText={setLicPass}
                    placeholder="Password"
                    placeholderTextColor={colors.inkFaint}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <SoftButton
                    icon="lock"
                    label={licBusy ? 'Signing in…' : 'Sign in'}
                    onPress={onSignIn}
                    disabled={licBusy || !licEmail || !licPass}
                  />
                </>
              )}
            </View>
          </Raised>
        </View>

        <View style={st.ruleWrap}>
          <SectionRule label="MOVING DEVICES" />
        </View>
        <View style={st.list}>
          <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
            <View style={st.rowPad}>
              <Txt variant="bodyStrong">Back up your meetings</Txt>
              <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                A single encrypted file you can carry to another phone. Nothing is uploaded — the
                only server this app contacts handles subscriptions, and it has nowhere to put a
                meeting.
              </Txt>
              {/* The passphrase is the whole security of the file, and forgetting it is
                  unrecoverable BY DESIGN — an export only you can decrypt is one nobody, us
                  included, can open for you later. Said here rather than after the fact. */}
              <TextInput
                style={[st.pass, { borderColor: colors.line, color: colors.ink }]}
                value={pass}
                onChangeText={setPass}
                placeholder="Passphrase"
                placeholderTextColor={colors.inkFaint}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                Write this down. If you lose it the backup cannot be opened — not by you, and not
                by us.
              </Txt>
              <View style={st.backupRow}>
                <View style={st.flex}>
                  <SoftButton
                    icon="share"
                    label={busy === 'export' ? 'Working…' : 'Back up'}
                    onPress={onBackup}
                    disabled={busy !== null || pass.length < 6}
                  />
                </View>
                <View style={st.flex}>
                  <SoftButton
                    icon="restore"
                    label={busy === 'restore' ? 'Working…' : 'Restore'}
                    onPress={onRestore}
                    disabled={busy !== null || pass.length < 6}
                  />
                </View>
              </View>
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
    pass: {
      borderWidth: 1,
      borderRadius: s(12),
      paddingHorizontal: s(12),
      paddingVertical: s(10),
      marginTop: s(10),
    },
    backupRow: { flexDirection: 'row', gap: s(10), marginTop: s(12) },
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
