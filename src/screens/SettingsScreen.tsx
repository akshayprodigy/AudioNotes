import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Linking,
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
import { NOTICES } from '../legal/notices';
import SignInForm from '../billing/SignInForm';
import { db } from '../db/queries';
import { PipelineController } from '../pipeline/PipelineController';
import Icon from '../components/Icon';
import { confirmDestructive } from '../components/confirm';
import {
  Button,
  IconButton,
  Pop,
  ProgressBar,
  Raised,
  SectionRule,
  Segmented,
  SoftButton,
  Switch,
  Txt,
} from '../components/ui';
import Backup from '../native/NativeBackup';
import Licence, { type LicenceStatus } from '../native/NativeLicence';
import {
  buyWithPlay,
  playAvailable,
  playPrice,
  restorePlayPurchase,
  signOut,
} from '../billing/subscription';
import {
  crashConsent,
  crashReportingAvailable,
  setCrashConsent,
} from '../telemetry/crash';
import { radius, s, useTheme, type Colors, type ThemeMode } from '../theme';

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
 * How long a recording is kept after it has been transcribed.
 *
 * Written as `audioRetentionDays`, in days, with two sentinels: -1 keeps audio until the meeting
 * is deleted, 0 deletes it the moment the transcript exists. Native sweeps against this value.
 *
 * Seven days is the new default and is a deliberate change from "delete immediately". Deleting at
 * once is the strongest privacy answer, and it is also the one that quietly removes the ability to
 * play a turn back and check what was actually said — which is the difference between notes you
 * trust and notes you hope are right. A week is long enough to go back and verify the meeting you
 * are still working from, and short enough that a phone does not fill up with something nobody
 * will ever open again.
 */
const RETENTION_DEFAULT_DAYS = 7;

const RETENTION_CHOICES: { days: number; label: string; detail: string }[] = [
  {
    days: 7,
    label: 'Keep for 7 days',
    detail: 'Long enough to play back and check anything from the meetings you are still working from.',
  },
  {
    days: 30,
    label: 'Keep for 30 days',
    detail: 'A month of audio is around 3 GB if you record an hour a day. Worth it if you often go back.',
  },
  {
    days: -1,
    label: 'Keep until I delete it',
    detail: 'Nothing is ever removed on its own. You are the one watching the storage.',
  },
  {
    days: 0,
    label: 'Delete as soon as it is transcribed',
    detail: 'The strictest option, and the one that gives up playback: only the text survives.',
  },
];

/**
 * The language SPOKEN in the meeting, written as `asrLanguage`.
 *
 * This exists because auto-detect is genuinely wrong on the audio this app is built for. Whisper
 * base, left to detect, transcribes Hindi/English code-switched speech into Arabic script — and
 * pinned to English it invents fluent English that was never said. Neither failure is one a user
 * can diagnose; both are ones they can fix in a tap if we let them.
 */
const LANGUAGE_CHOICES: { code: string; label: string }[] = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
];

const THEME_CHOICES: { key: ThemeMode; label: string }[] = [
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
  { key: 'system', label: 'System' },
];

export default function SettingsScreen({ navigation }: Props) {
  const { colors, isDark, mode, setMode } = useTheme();
  // Subscription. The app never advertises a price or links to a checkout — it signs in, and
  // buying happens on the web. That separation is deliberate; see the licence server's README.
  const [lic, setLic] = React.useState<LicenceStatus | null>(null);
  const [signedInAs, setSignedInAs] = React.useState<string | null>(null);

  // Google Play Billing. `playCan` is false on a side-load or an install from another store, where
  // Play Billing simply does not work — there the web account is the only route, which is also why
  // the email sign-in never goes away entirely.
  const [playCan, setPlayCan] = React.useState(false);
  const [playCost, setPlayCost] = React.useState<string | null>(null);
  const [playBusy, setPlayBusy] = React.useState(false);
  // Secondary on purpose. Somebody on a Play install should be buying through Play; this is for
  // the person who already subscribed on the web or, later, on a desktop.
  const [showEmailSignIn, setShowEmailSignIn] = React.useState(false);
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

  // What Play can do here, asked once. Both calls are cheap and both fail closed: a device with
  // no Play Store answers false and the UI falls back to the web account.
  React.useEffect(() => {
    playAvailable().then(async can => {
      setPlayCan(can);
      if (can) setPlayCost(await playPrice());
    });
  }, []);

  // Runs on open, and is what makes a reinstall or a new phone work: Play remembers the purchase,
  // the server turns it back into a licence for this device. A no-op when nothing is owned.
  React.useEffect(() => {
    restorePlayPurchase()
      .then(r => {
        if (r.paid) refreshLicence();
      })
      .catch(() => {});
  }, [refreshLicence]);

  const onBuy = React.useCallback(async () => {
    setPlayBusy(true);
    try {
      const result = await buyWithPlay();
      if (result.paid) {
        await refreshLicence();
        Alert.alert('You are on Pro', 'The written summary and minutes are on. Enjoy.');
      }
      // Not paid means the buyer backed out, or a payment method still authorising. Neither
      // deserves a dialog — the first is a decision, the second resolves itself.
    } catch (e: any) {
      Alert.alert('Could not complete the purchase', String(e?.message ?? e));
    } finally {
      setPlayBusy(false);
    }
  }, [refreshLicence]);

  const onRestorePurchase = React.useCallback(async () => {
    setPlayBusy(true);
    try {
      const result = await restorePlayPurchase();
      await refreshLicence();
      Alert.alert(
        result.paid ? 'Subscription restored' : 'Nothing to restore',
        result.paid
          ? 'Pro is back on this device.'
          : 'This Google account has no subscription to Verbale.',
      );
    } catch (e: any) {
      Alert.alert('Could not restore', String(e?.message ?? e));
    } finally {
      setPlayBusy(false);
    }
  }, [refreshLicence]);

  // Play's own subscription screen. Managing or cancelling an existing Play subscription is what
  // this link is for; it is not a route to buy one, which is what store policy cares about.
  const onManage = React.useCallback(() => {
    Linking.openURL('https://play.google.com/store/account/subscriptions').catch(() => {});
  }, []);

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
  // null until the stored value has been read. Rendering a picker with a guessed selection and
  // then moving it under the user's finger a frame later is worse than rendering nothing.
  const [retention, setRetention] = useState<number | null>(null);
  const [language, setLanguage] = useState('auto');
  const [empties, setEmpties] = useState(0);
  // Same reason as `retention` above: null until read, so the switch never animates itself from a
  // guess to the truth. Consent is the last thing that should appear to change on its own.
  const [crashOn, setCrashOn] = useState<boolean | null>(null);

  useEffect(() => {
    if (!crashReportingAvailable()) return;
    crashConsent()
      .then(v => setCrashOn(v === 'on'))
      .catch(() => {});
  }, []);

  const refresh = () => ModelManager.list().then(r => setModels(JSON.parse(r)));

  const countEmpties = useCallback(() => {
    db.emptyMeetings()
      .then(r => setEmpties(r.length))
      .catch(() => {});
  }, []);

  /**
   * Read the retention preference, migrating anyone who only ever set the old switch.
   *
   * `keepAudio` was a boolean: on meant keep forever, off (and unset) meant delete the moment the
   * transcript existed. Someone who deliberately turned it on must not silently become a 7-day
   * user, so their choice maps to "until I delete it" and only a phone that has never expressed
   * an opinion gets the new default.
   *
   * The migration WRITES, rather than deriving on each render, because the native sweep reads the
   * setting and not this screen. A default that lives only in the UI is a default the app does
   * not actually have.
   */
  const readRetention = useCallback(async () => {
    try {
      const stored = await db.getSetting('audioRetentionDays');
      const n = Number(stored);
      if (stored !== null && Number.isFinite(n)) {
        setRetention(Math.trunc(n));
        return;
      }
      const legacy = await db.getSetting('keepAudio');
      const derived = legacy === '1' ? -1 : legacy === '0' ? 0 : RETENTION_DEFAULT_DAYS;
      setRetention(derived);
      await db.setSetting('audioRetentionDays', String(derived));
      if (legacy === null) await db.setSetting('keepAudio', derived === 0 ? '0' : '1');
    } catch {
      // A settings read that fails leaves the picker unrendered rather than showing a lie about
      // what the app is doing with the audio.
    }
  }, []);

  useEffect(() => {
    readRetention();
    db.getSetting('asrLanguage')
      .then(v => setLanguage(v ?? 'auto'))
      .catch(() => {});
    countEmpties();
    const offFocus = navigation.addListener('focus', () => {
      countEmpties();
    });
    return () => {
      offFocus();
    };
  }, [navigation, countEmpties, readRetention]);

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
   * Both keys, always, and in that order.
   *
   * `audioRetentionDays` is the real setting. `keepAudio` is the one ProcessingEngine.applyRetention
   * has read since before this picker existed, and there are installs out there whose only stored
   * preference is that boolean — so it is kept in step rather than deleted: anything but "delete
   * immediately" means the file survives transcription, and how long it then survives for is the
   * sweep's business.
   */
  const chooseRetention = async (days: number) => {
    setRetention(days);
    try {
      await db.setSetting('audioRetentionDays', String(days));
      await db.setSetting('keepAudio', days === 0 ? '0' : '1');
    } catch (e: any) {
      Alert.alert('Could not save that', String(e?.message ?? e));
      readRetention();
    }
  };

  const chooseLanguage = async (code: string) => {
    setLanguage(code);
    await db.setSetting('asrLanguage', code).catch(() => {});
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

  // One form, three places now: here, behind "I already have an account" on a Play install, and
  // on the paywall — which is the screen that explains Pro and, until recently, offered an
  // existing subscriber no way to say they already had it.
  const emailSignIn = (
    <SignInForm
      onSignedIn={async res => {
        setSignedInAs(res.email);
        await refreshLicence();
      }}
    />
  );

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
              ) : lic?.paid ? (
                <View style={st.backupRow}>
                  <View style={st.flex}>
                    {playCan ? (
                      <SoftButton icon="settings" label="Manage subscription" onPress={onManage} />
                    ) : null}
                  </View>
                  {signedInAs ? (
                    <View style={st.flex}>
                      <SoftButton icon="x" label="Sign out" onPress={onSignOut} />
                    </View>
                  ) : null}
                </View>
              ) : playCan ? (
                <>
                  <Button
                    icon="check"
                    label={
                      playBusy
                        ? 'One moment…'
                        : playCost
                          ? `Subscribe — ${playCost}`
                          : 'Subscribe'
                    }
                    onPress={onBuy}
                    disabled={playBusy}
                    full
                  />
                  <View style={st.backupRow}>
                    <View style={st.flex}>
                      <SoftButton
                        icon="download"
                        label="Restore purchase"
                        onPress={onRestorePurchase}
                        disabled={playBusy}
                      />
                    </View>
                  </View>
                  {/* Secondary, and phrased as a statement of fact rather than an invitation.
                      Honouring a subscription bought elsewhere is permitted; steering somebody
                      there is not, so this says where an existing account can be used and offers
                      no price, no link and no way to buy. */}
                  {showEmailSignIn ? (
                    <>
                      <Txt variant="chip" color={colors.inkFaint} style={st.tiny}>
                        For an account that already has a subscription.
                      </Txt>
                      {emailSignIn}
                    </>
                  ) : (
                    <SoftButton
                      icon="users"
                      label="I already have an account"
                      onPress={() => setShowEmailSignIn(true)}
                    />
                  )}
                </>
              ) : signedInAs ? (
                <View style={st.backupRow}>
                  <View style={st.flex}>
                    <SoftButton icon="x" label="Sign out" onPress={onSignOut} />
                  </View>
                </View>
              ) : (
                emailSignIn
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
          <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
            <View style={st.rowPad}>
              <Txt variant="bodyStrong">Keep the audio</Txt>
              <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                Recordings are about 115 MB an hour. Keeping them is what lets you tap a line of
                the transcript and hear what was actually said — the transcript and minutes are
                kept either way, encrypted.
              </Txt>
              {/* Nothing is rendered until the stored value has been read: a picker that shows a
                  guessed selection and then moves under the user's finger is worse than a pause. */}
              {retention === null ? null : (
                <View style={st.choices}>
                  {RETENTION_CHOICES.map(c => {
                    const on = c.days === retention;
                    return (
                      <Pressable
                        key={c.days}
                        onPress={() => chooseRetention(c.days)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={c.label}
                        style={[
                          st.choice,
                          { borderColor: on ? colors.primary : colors.line },
                          on && { backgroundColor: colors.primarySoft },
                        ]}>
                        <View style={st.flex}>
                          <Txt variant="chip" color={on ? colors.primaryDeep : colors.ink}>
                            {c.label}
                          </Txt>
                          <Txt variant="chipSoft" color={colors.inkSoft} style={st.tiny}>
                            {c.detail}
                          </Txt>
                        </View>
                        {on ? (
                          <Icon name="check" size={s(16)} color={colors.primaryDeep} strokeWidth={2.8} />
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              )}
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
          <SectionRule label="TRANSCRIPTION" />
        </View>
        <View style={st.list}>
          <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
            <View style={st.rowPad}>
              <Txt variant="bodyStrong">Language spoken</Txt>
              {/* Auto-detect is genuinely wrong on the audio this app is built for, and neither of
                  its two failures is one a user can diagnose from the result — so the fix is put
                  where they can reach it, and described by what they would SEE. */}
              <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                Left to detect, the model decides again every 30 seconds — so one meeting can come
                back in several languages, or in the wrong script entirely. If you know what was
                spoken, say so here and reprocess.
              </Txt>
              <Segmented
                style={st.segment}
                items={LANGUAGE_CHOICES.map(l => ({ key: l.code, label: l.label }))}
                value={language}
                onChange={chooseLanguage}
              />
              <Txt variant="chipSoft" color={colors.inkSoft} style={st.tiny}>
                Applies to the next meeting transcribed, and to anything you reprocess.
              </Txt>
            </View>
          </Raised>
        </View>

        <View style={st.ruleWrap}>
          <SectionRule label="APPEARANCE" />
        </View>
        <View style={st.list}>
          <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
            <View style={st.rowPad}>
              <View style={st.row}>
                <Icon
                  name={isDark ? 'moon' : 'sun'}
                  size={s(18)}
                  color={colors.inkSoft}
                  strokeWidth={2.4}
                />
                <Txt variant="bodyStrong" style={st.flex}>
                  Theme
                </Txt>
              </View>
              <Segmented
                style={st.segment}
                items={THEME_CHOICES.map(t => ({ key: t.key, label: t.label }))}
                value={mode}
                onChange={k => setMode(k as ThemeMode)}
              />
            </View>
          </Raised>
        </View>

        {/* Only shown when the build can actually report a crash. With no DSN configured there is
            nothing behind this switch, and a privacy control that does nothing is worse than an
            absent one — it invites somebody to believe they turned something off. */}
        {crashReportingAvailable() && crashOn !== null ? (
          <>
            <View style={st.ruleWrap}>
              <SectionRule label="DIAGNOSTICS" />
            </View>
            <View style={st.list}>
              <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
                <View style={st.rowPad}>
                  <View style={st.row}>
                    <Icon name="shield" size={s(18)} color={colors.inkSoft} strokeWidth={2.4} />
                    <View style={st.flex}>
                      <Txt variant="bodyStrong">Send crash reports</Txt>
                      <Txt variant="meta" color={colors.inkDim}>
                        If the app crashes, send the technical details of the crash so it can be
                        fixed. No audio, no transcript, no minutes, no account — those never leave
                        this phone whether this is on or off.
                      </Txt>
                    </View>
                    <Switch
                      on={crashOn}
                      onToggle={() => {
                        const next = !crashOn;
                        setCrashOn(next);
                        setCrashConsent(next).catch(() => {});
                      }}
                    />
                  </View>
                </View>
              </Raised>
            </View>
          </>
        ) : null}

        <View style={st.ruleWrap}>
          <SectionRule label="ABOUT" />
        </View>
        <View style={st.list}>
          <Raised
            edge={colors.line}
            fill={colors.card}
            rad={radius.xl}
            depth={5}
            onPress={() => navigation.navigate('Notices')}>
            <View style={st.rowPad}>
              <View style={st.row}>
                <View style={st.flex}>
                  <Txt variant="bodyStrong">Open-source notices</Txt>
                  <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                    {NOTICES.length} components, and the licences they are given under
                  </Txt>
                </View>
                <Icon name="chevronRight" size={s(18)} color={colors.inkFaint} strokeWidth={2.4} />
              </View>
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
    segment: { marginTop: s(12) },
    choices: { marginTop: s(12), gap: s(8) },
    choice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(10),
      borderWidth: 1,
      borderRadius: radius.ctl,
      paddingHorizontal: s(12),
      paddingVertical: s(10),
    },
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
  });
}
