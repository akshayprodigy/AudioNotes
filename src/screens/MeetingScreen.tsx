import { unsupportedLanguageNote } from './languages';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  ToastAndroid,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MeetingTab, RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import { PipelineController } from '../pipeline/PipelineController';
import { shouldOfferPaywall } from '../billing/trial';
import FileExport from '../native/NativeFileExport';
import Icon from '../components/Icon';
import Mascot from '../components/Mascot';
import { confirmDestructive, quoted } from '../components/confirm';
import {
  Badge,
  IconButton,
  ProgressRing,
  GradientFill,
  Raised,
  Segmented,
  Sheet,
  SoftButton,
  TextPrompt,
  Txt,
  type SheetAction,
} from '../components/ui';
import SummaryTab from './meeting/SummaryTab';
import MinutesTab from './meeting/MinutesTab';
import ActionsTab from './meeting/ActionsTab';
import TranscriptTab from './meeting/TranscriptTab';
import PlayerBar from './meeting/PlayerBar';
import { usePlayer } from './meeting/usePlayer';
import type { EditTarget, Meeting, Minute, MinuteKind, Speaker, Utterance } from '../pipeline/types';
import {
  DOC_KEY,
  composeAction,
  itemKey,
  minuteText,
  toEditMap,
  type EditMap,
} from './meeting/shared';
import { radius, s, sv, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Meeting'>;

/**
 * Pipeline stages, phrased as what they achieve, with the cost of each measured on device (the
 * `stage=` timings logged by AudioPipelineModule) as seconds of work per second of audio.
 *
 * Cost is held as a RATE rather than as a share of the whole, because a share only describes the
 * run it was measured on. A re-run that still has its transcript skips VAD, ASR and diarization
 * outright, so those four stages complete in well under a second — and an ETA that divided
 * elapsed time by percent-complete read that as the pace of the entire job. The screen said
 * "92% · about 1s left" with eight minutes of writing still ahead of it. A rate against the
 * meeting's own length survives a skipped stage, because a stage that does not run costs nothing.
 *
 * The rates also drive the ring, so progress advances at a roughly even pace rather than sitting
 * at 5% and then jumping to done.
 */
const STAGES: { key: string; label: string; rate: number }[] = [
  { key: 'vad', label: 'Audio cleaned up', rate: 0.08 },
  // whisper-base runs at about 0.68x realtime, two threads.
  { key: 'asr', label: 'Words written down', rate: 1.47 },
  { key: 'diarize', label: 'Speakers separated', rate: 0.67 },
  { key: 'minutes', label: 'Pulling out the minutes', rate: 0.11 },
  // 460 s of narration against a 24-minute recording, three chunks, on the IPD meeting. Prefill
  // at ~37 tok/s dominates, so the cost tracks transcript length rather than anything else.
  { key: 'narrate', label: 'Written up in plain English', rate: 0.32 },
];
const TOTAL_RATE = STAGES.reduce((a, x) => a + x.rate, 0);

/** Seconds into a human wait. "480s left" is a number; "about 8 min left" is an answer. */
function etaLabel(sec: number): string {
  if (sec <= 0) return '';
  if (sec < 90) return ` · about ${sec}s left`;
  return ` · about ${Math.round(sec / 60)} min left`;
}

export default function MeetingScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { meetingId, tab: initialTab, atMs } = route.params;

  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [minutes, setMinutes] = useState<Minute[]>([]);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [speechMs, setSpeechMs] = useState(0);
  const [reprocessing, setReprocessing] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const [sheet, setSheet] = useState(false);
  // Summary unless the caller asked for somewhere specific. Nothing is REMEMBERED between visits:
  // tapping two meetings in a row and landing on different screens reads as a bug rather than a
  // convenience. A search hit is different — it knows where it is sending you, and why.
  const [tab, setTab] = useState<string>(initialTab ?? 'summary');
  const [renaming, setRenaming] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagging, setTagging] = useState(false);
  const [edits, setEdits] = useState<EditMap>(new Map());

  /**
   * What the edit prompt is currently pointed at, or null.
   *
   * One prompt for the whole screen rather than one per tab: an editable line is an editable line
   * whether it is a transcript turn, a decision or the summary, and four copies of the same modal
   * is four places for the save path to diverge.
   *
   * `add` carries the kind for a brand-new item, which is the one case with no target to key on
   * until after it has been written.
   */
  const [editing, setEditing] = useState<{
    title: string;
    hint?: string;
    initial: string;
    multiline?: boolean;
    confirmLabel?: string;
    target?: { kind: EditTarget; key: string };
    add?: MinuteKind;
    extraPlaceholder?: string;
  } | null>(null);

  const player = usePlayer(meetingId);

  const openPaywall = useCallback(
    () => navigation.navigate('Paywall', { meetingId }),
    [navigation, meetingId],
  );

  /**
   * Offer Pro once, on the first meeting that finishes.
   *
   * This is the only moment in the app where the paid half can be explained honestly: the user has
   * just watched it do its work, on their own meeting, and can see the shape of what is missing.
   * Before that it is a feature list; after it, on the fifth meeting, it is a nag.
   *
   * `shouldOfferPaywall` is what keeps it to once EVER — never to a subscriber, never to somebody
   * who already decided by starting the trial, and never twice, because the second showing is not
   * persuasion and this app's whole pitch is that it does not behave like that. The delay lets the
   * meeting render first, so the sheet arrives over the notes rather than instead of them.
   */
  useEffect(() => {
    if (meeting?.status !== 'done') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    shouldOfferPaywall()
      .then(offer => {
        if (!alive || !offer) return;
        timer = setTimeout(() => {
          if (alive) openPaywall();
        }, 900);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [meeting?.status, openPaywall]);

  // `atMs` — the moment a search hit matched — only scrolls the transcript to that line; it does
  // NOT move the playhead. Seeking would mean opening the audio device merely to look at a search
  // result: it takes audio focus, and it fails outright while a recording is running, so opening
  // a hit mid-meeting would raise an error about playback nobody had asked for. The line is on
  // screen and one tap plays it, which is the whole of what the hit promised.

  const refresh = useCallback(async () => {
    const [mtg, mins, utts, segs, spk, eds, tgs] = await Promise.all([
      db.getMeeting(meetingId),
      db.minutes(meetingId),
      db.utterances(meetingId),
      db.segments(meetingId),
      db.speakers(meetingId),
      db.edits(meetingId).catch(() => []),
      db.tagsFor(meetingId).catch(() => []),
    ]);
    setMeeting(mtg ?? null);
    setMinutes(mins);
    setUtterances(utts);
    setSpeakers(spk);
    setEdits(toEditMap(eds));
    setTags(tgs);
    setSpeechMs(segs.reduce((a, x) => a + (x.end_ms - x.start_ms), 0));
    return mins.length;
  }, [meetingId]);

  useEffect(() => {
    let cancelled = false;
    let ticks = 0;
    const load = async () => {
      const count = await refresh();
      if (cancelled) return;
      if (count === 0 && ticks < 60) {
        ticks += 1;
        setTimeout(load, 2000);
      } else setSettled(true);
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    const offProgress = PipelineController.onProgress(p => {
      if (p.meetingId === meetingId) setStage(p.stage);
    });
    const offComplete = PipelineController.onComplete(e => {
      if (e.meetingId !== meetingId) return;
      setStage(null);
      setSettled(true);
      if (e.outcome === 'error') setFailure(e.message ?? 'Processing failed');
      refresh();
    });
    return () => {
      offProgress();
      offComplete();
    };
  }, [meetingId, refresh]);

  /**
   * Run the pipeline again.
   *
   * `rewriteProse` clears the LLM rows first. Without it a meeting that already has a summary has
   * no outstanding stages, so the run returns instantly and the button appears to do nothing —
   * see db.clearNarration. The Summary tab passes it; the Redo button in the overflow sheet does
   * not, because Redo is there to recover a run that fell over, not to spend eight minutes of
   * model time on prose that is already written.
   */
  const onReprocess = useCallback(
    async (rewriteProse = false) => {
      if (reprocessing) return;
      setReprocessing(true);
      setFailure(null);
      try {
        if (rewriteProse) {
          await db.clearNarration(meetingId);
          await refresh();
        }
        await PipelineController.process(meetingId, { model: 'base' });
        await refresh();
      } catch (e: any) {
        Alert.alert('Could not reprocess', String(e?.message ?? e));
      } finally {
        setReprocessing(false);
      }
    },
    [meetingId, refresh, reprocessing],
  );

  /**
   * Rename the meeting.
   *
   * Auto-titles are the first ~60 characters of the transcript, so a good half of them open with
   * "Okay so um yeah let's start" — which is the first thing anybody sees in the library, and the
   * first thing they see in an exported document. db.setTitle stamps `title_edited_at`, which is
   * what stops the pipeline's auto-retitle overwriting this on the next pass, and reindexes so the
   * new name is searchable straight away.
   */
  const onRename = useCallback(
    async (title: string) => {
      setRenaming(false);
      // Optimistic: the row is already on screen and re-reading it costs a frame of the old name.
      setMeeting(m => (m ? { ...m, title } : m));
      try {
        await db.setTitle(meetingId, title);
      } catch (e: any) {
        Alert.alert('Could not rename', String(e?.message ?? e));
        refresh();
      }
    },
    [meetingId, refresh],
  );

  /**
   * Save a correction, or a newly typed item.
   *
   * Corrections go into the `edits` side table rather than over the text they correct. Ticked
   * actions are keyed on a hash of the STORED minute text, so rewriting it in place would untick
   * every item the user had worked through — and reprocessing would overwrite their words anyway,
   * since it owns the `rule` rows. A side row survives both and makes revert a single delete.
   */
  const onSaveEdit = useCallback(
    async (value: string, extra: string) => {
      const spec = editing;
      setEditing(null);
      if (!spec) return;
      try {
        if (spec.add) {
          // Actions are stored in the extractor's own `<sentence> — <owner>` shape so a typed one
          // and an extracted one are the same kind of row everywhere downstream — splitAction
          // renders both, the export writes both, and the tick key hashes both the same way.
          const content =
            spec.add === 'action' ? composeAction(value, extra || 'Unassigned') : value;
          await db.addUserMinute(meetingId, spec.add, content);
          await refresh();
          return;
        }
        if (!spec.target) return;
        const { kind, key } = spec.target;
        // Optimistic, and cheap to be: the row is on screen and the map is the only thing the
        // render reads. A failed write is put right by the refresh in the catch.
        setEdits(prev => new Map(prev).set(`${kind}/${key}`, value));
        await db.putEdit(meetingId, kind, key, value);
      } catch (e: any) {
        Alert.alert('Could not save that', String(e?.message ?? e));
        refresh();
      }
    },
    [editing, meetingId, refresh],
  );

  /** Drop a correction, restoring whatever the pipeline wrote. */
  const onRevertEdit = useCallback(
    async (kind: EditTarget, key: string) => {
      setEdits(prev => {
        const next = new Map(prev);
        next.delete(`${kind}/${key}`);
        return next;
      });
      try {
        await db.clearEdit(meetingId, kind, key);
      } catch {
        refresh();
      }
    },
    [meetingId, refresh],
  );

  /** Remove an item the user added. Only ever reachable on a source='user' row. */
  const onRemoveMinute = useCallback(
    async (id: string) => {
      try {
        await db.deleteUserMinute(meetingId, id);
        await refresh();
      } catch (e: any) {
        Alert.alert('Could not remove that', String(e?.message ?? e));
      }
    },
    [meetingId, refresh],
  );

  /** Open the prompt on a minute — the correction path shared by the MOM and Actions tabs. */
  const onEditMinute = useCallback(
    (m: Minute) => {
      // Keyed on the STORED content, never on what is displayed. The export renderer computes
      // the same key in Kotlin (ItemKey.of) straight from the database column, so a key derived
      // from the display text would write an edit the exported document could never find.
      const key = itemKey(m.content);
      setEditing({
        title: 'Correct this line',
        hint: 'Your wording replaces what the app wrote. The original is kept, and you can put it back.',
        initial: edits.get(`minute/${key}`) ?? minuteText(m),
        multiline: true,
        target: { kind: 'minute', key },
      });
    },
    [edits],
  );

  const onAddMinute = useCallback((kind: MinuteKind) => {
    setEditing({
      title: kind === 'decision' ? 'Add a decision' : 'Add an action',
      hint:
        kind === 'decision'
          ? 'Something that was agreed but the app did not pick up.'
          : 'Something somebody owes. Reprocessing this meeting will not remove it.',
      initial: '',
      multiline: true,
      confirmLabel: 'Add',
      add: kind,
      extraPlaceholder: kind === 'action' ? 'Who owes it (optional)' : undefined,
    });
  }, []);

  const onAddTag = useCallback(
    async (name: string) => {
      setTagging(false);
      try {
        await db.addTag(meetingId, name);
        setTags(await db.tagsFor(meetingId));
      } catch (e: any) {
        Alert.alert('Could not add that tag', String(e?.message ?? e));
      }
    },
    [meetingId],
  );

  /**
   * Remove a tag on a single tap, with no confirmation.
   *
   * Deliberately not a destructive-confirm: a tag holds no content, putting it back is one tap,
   * and a dialog in front of something that cheap is the kind of friction that stops people
   * using tags at all.
   */
  const onRemoveTag = useCallback(
    async (name: string) => {
      setTags(prev => prev.filter(t => t !== name));
      await db.removeTag(meetingId, name).catch(() => refresh());
    },
    [meetingId, refresh],
  );

  /**
   * Say it worked, without saying it twice.
   *
   * Android 13 shows its own clipboard confirmation for every copy, so anything we add on top of
   * that is a second popup for one action. Below 33 there is no system feedback at all and a copy
   * that says nothing is indistinguishable from a copy that failed.
   */
  const copied = useCallback((what: string) => {
    if (Number(Platform.Version) >= 33) return;
    ToastAndroid.show(`${what} copied`, ToastAndroid.SHORT);
  }, []);

  const copyText = useCallback(
    async (value: string, what: string) => {
      try {
        await FileExport.copy(value);
        copied(what);
      } catch (e: any) {
        Alert.alert('Could not copy', String(e?.message ?? e));
      }
    },
    [copied],
  );

  /**
   * Copy part of the meeting as a document.
   *
   * Rendered by the SAME native renderer as the export, so what lands on the clipboard is what the
   * share sheet would have produced — corrections included. A second, JS-side description of the
   * format would drift, and the one people notice drifting is the one they paste to a client.
   */
  const copyDoc = useCallback(
    async (format: 'md' | 'transcript', what: string) => {
      try {
        await copyText(await FileExport.render(meetingId, format), what);
      } catch (e: any) {
        Alert.alert('Could not copy', String(e?.message ?? e));
      }
    },
    [meetingId, copyText],
  );

  const onCopy = useCallback(() => copyDoc('md', 'Minutes'), [copyDoc]);

  // PDF first: it is what gets attached to an email and read by the person who was not in the
  // meeting, and the only format that looks the same wherever it lands.
  const onExport = () =>
    Alert.alert('Export minutes', 'Choose a format', [
      { text: 'PDF', onPress: () => FileExport.share(meetingId, 'pdf') },
      { text: 'Markdown', onPress: () => FileExport.share(meetingId, 'md') },
      { text: 'Plain text', onPress: () => FileExport.share(meetingId, 'txt') },
      { text: 'Subtitles (.srt)', onPress: () => FileExport.share(meetingId, 'srt') },
      { text: 'Cancel', style: 'cancel' },
    ]);

  // A recording we declined to transcribe is FINISHED, not in flight. Without this it fell through
  // to the progress view and span on "Writing your notes..." forever, because nothing was running
  // to ever report completion — and once that was fixed it fell through again to "could not hear
  // any speech", which is a different and untrue explanation. Cleared the moment a reprocess
  // starts, so Redo shows real progress.
  const refused =
    meeting?.status === 'unsupported_language' && !reprocessing && stage === null;
  const working = !refused && (stage !== null || reprocessing || (!settled && minutes.length === 0));
  const empty = !refused && settled && !working && minutes.length === 0 && utterances.length === 0;

  /**
   * Per-meeting actions, in the overflow sheet.
   *
   * Speakers, Export and Redo used to sit in a button row on the results page. The tab refactor
   * dropped that row, which left a finished meeting with no way to reprocess it — and reprocessing
   * is exactly what every meeting recorded before narration shipped needs. They live here now
   * rather than as a permanent row, which would cost vertical space on all four tabs.
   *
   * Archive and Delete both leave this screen, so both pop back to the library first — a detail
   * screen for a meeting just archived out of the library, or deleted outright, has nothing left
   * to show and its polling refresh would query a row that no longer exists.
   */
  const sheetActions: SheetAction[] = [
    {
      icon: 'users',
      label: 'Speakers',
      hint: 'Rename people, or merge two speakers the app split apart.',
      onPress: () => navigation.navigate('Speakers', { meetingId }),
    },
    {
      icon: 'edit',
      label: 'Rename',
      hint: 'Auto-titles are the first words of the transcript. Give it the name you would look for.',
      onPress: () => setRenaming(true),
    },
    {
      icon: 'plus',
      label: 'Add a tag',
      hint: 'Group this with meetings like it — a client, a project, a weekly.',
      onPress: () => setTagging(true),
    },
    {
      icon: 'share',
      label: 'Export',
      hint: 'Share the minutes as a PDF, Markdown, plain text or subtitles.',
      onPress: onExport,
    },
    {
      icon: 'copy',
      label: 'Copy',
      hint: 'Puts the whole write-up on the clipboard, ready to paste.',
      onPress: onCopy,
    },
    {
      icon: 'refresh',
      label: reprocessing ? 'Working…' : 'Redo',
      hint: 'Run any stage that has not finished. To rewrite the summary, use the Summary tab.',
      onPress: () => onReprocess(),
    },
    {
      icon: 'archive',
      label: 'Archive',
      hint: 'Hides it from the library. Nothing is deleted, and you can restore it.',
      onPress: async () => {
        await db.setArchived(meetingId, true).catch(() => {});
        navigation.goBack();
      },
    },
    {
      icon: 'trash',
      label: 'Delete',
      hint: 'Removes the recording, transcript and minutes for good.',
      destructive: true,
      onPress: () =>
        confirmDestructive({
          title: 'Delete this meeting?',
          message: `The recording, transcript and minutes for ${quoted(
            meeting?.title,
          )} will be permanently deleted. This cannot be undone.`,
          confirmLabel: 'Delete',
          onConfirm: async () => {
            await PipelineController.deleteMeeting(meetingId).catch(() => {});
            navigation.goBack();
          },
        }),
    },
  ];

  // The same three actions the finished meeting offers, in the same stacked form — they are the
  // same controls, and rendering them label-only here made the screen look like a different app.
  const Footer = () => (
    <View style={st.footer}>
      <SoftButton
        icon="users"
        label="Speakers"
        stacked
        onPress={() => navigation.navigate('Speakers', { meetingId })}
      />
      <SoftButton icon="share" label="Export" stacked onPress={onExport} />
      <SoftButton
        icon="refresh"
        label={reprocessing ? 'Working…' : 'Redo'}
        stacked
        onPress={() => onReprocess()}
        disabled={reprocessing}
      />
    </View>
  );

  // ---------- Processing ----------
  if (working) {
    const found = STAGES.findIndex(x => x.key === (stage ?? 'vad'));
    const idx = found < 0 ? 0 : found;
    // A stage reports only that it started, so treat the running one as 40% through.
    const RUNNING = 0.4;
    const doneRate = STAGES.slice(0, idx).reduce((a, x) => a + x.rate, 0);
    const pct = Math.round(((doneRate + STAGES[idx].rate * RUNNING) / TOTAL_RATE) * 100);
    // Remaining work priced from the recording's own length rather than from elapsed time, which
    // is what made a transcript-only re-run promise a finish it was nowhere near.
    const audioSec = (meeting?.durationMs ?? 0) / 1000;
    const remainingRate =
      STAGES.slice(idx).reduce((a, x) => a + x.rate, 0) - STAGES[idx].rate * RUNNING;
    const eta = audioSec > 0 ? Math.max(1, Math.round(remainingRate * audioSec)) : 0;

    return (
      <View style={[st.root, { paddingTop: insets.top + s(8), paddingBottom: insets.bottom + s(20) }]}>
        <View style={st.pad}>
          <View style={st.navRow}>
            <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
            <Txt variant="sectionTitle" style={st.flex}>
              Meeting
            </Txt>
            {/* Reachable mid-run on purpose: a mis-tapped recording is exactly the one you want
                to throw away, and waiting out the pipeline first to be allowed to is absurd.
                deleteMeeting cancels the run before it touches anything. */}
            <IconButton icon="more" label="More actions" onPress={() => setSheet(true)} />
          </View>

          <View style={st.procHead}>
            <ProgressRing pct={pct} size={sv(150)} stroke={s(8)}>
              <Mascot mood="thinking" size={sv(94)} />
            </ProgressRing>
            <Txt variant="display" style={st.procTitle}>
              Writing your notes…
            </Txt>
            <Txt variant="sub" color={colors.inkDim} style={st.procBody}>
              All the thinking happens on your phone, so it takes a moment.
            </Txt>
            <View style={st.pctPill}>
              <Txt variant="metaBlack" color={colors.primary}>
                {pct}%{etaLabel(eta)}
              </Txt>
            </View>
          </View>

          <View style={st.checkWrap}>
            <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={6}>
              <View style={st.checkInner}>
                {STAGES.map((x, i) => {
                  const state = i < idx ? 'done' : i === idx ? 'active' : 'todo';
                  return (
                    <View key={x.key}>
                      {i > 0 && state !== 'active' ? <View style={st.divider} /> : null}
                      <View
                        style={[
                          st.checkRow,
                          state === 'active' && {
                            borderRadius: radius.ctl,
                            overflow: 'hidden',
                          },
                          state === 'todo' && { opacity: 0.45 },
                        ]}>
                        {/* The design tints the active row with a 90deg #F6F7FE -> #fff wash,
                            so it fades out toward the right rather than sitting as a flat block. */}
                        {state === 'active' ? (
                          <GradientFill from="#F6F7FE" to="#FFFFFF" angle={90} />
                        ) : null}
                        {state === 'done' ? (
                          <View style={[st.checkDot, { backgroundColor: colors.successSoft }]}>
                            <Icon name="check" size={s(16)} color={colors.success} strokeWidth={3.2} />
                          </View>
                        ) : state === 'active' ? (
                          <Spinner size={s(30)} color={colors.primary} track="#DDE1F5" />
                        ) : (
                          <View style={[st.checkDot, { backgroundColor: colors.cardAlt }]} />
                        )}
                        <Txt
                          variant={state === 'active' ? 'bodyBlack' : 'bodyStrong'}
                          color={state === 'active' ? colors.primary : state === 'todo' ? colors.inkDim : colors.ink}>
                          {x.label}
                        </Txt>
                      </View>
                    </View>
                  );
                })}
              </View>
            </Raised>
          </View>

          <View style={st.spacer} />
          <Footer />
        </View>
        <Sheet
          visible={sheet}
          title={meeting?.title || 'Meeting'}
          actions={sheetActions}
          onClose={() => setSheet(false)}
        />
      </View>
    );
  }

  // Order is what people reach for, in order: what was this about, then the written minutes, then
  // the record itself, then the worklist. Actions is last because it is the one you go to
  // deliberately — the other three are what you read.
  const TABS = [
    { key: 'summary', label: 'Summary' },
    { key: 'mom', label: 'MOM' },
    { key: 'transcript', label: 'Script' },
    { key: 'actions', label: 'Actions' },
  ];

  return (
    <View style={[st.root, { paddingTop: insets.top + s(6) }]}>
      <View style={st.navRowDetail}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        {/* Tapping the title renames it. The overflow sheet carries the same action with a label
            on it, because a bare tappable heading is discoverable only by accident. */}
        <Pressable
          style={st.flex}
          onPress={() => setRenaming(true)}
          accessibilityRole="button"
          accessibilityLabel={`Rename ${meeting?.title || 'this meeting'}`}>
          <Txt variant="sectionTitle" numberOfLines={1}>
            {meeting?.title || 'Meeting'}
          </Txt>
          <Txt variant="chipSoft" color={colors.inkFaint}>
            {meeting?.createdAt
              ? new Date(meeting.createdAt).toLocaleString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : ''}
          </Txt>
        </Pressable>
        {meeting?.status === 'done' ? (
          <Badge label="READY" color={colors.success} soft={colors.successSoft} small />
        ) : null}
        <IconButton icon="more" label="More actions" onPress={() => setSheet(true)} />
      </View>

      {tags.length > 0 ? (
        <View style={st.tagRow}>
          {tags.map(t => (
            <Pressable
              key={t}
              onPress={() => onRemoveTag(t)}
              accessibilityRole="button"
              accessibilityLabel={`Remove the tag ${t}`}
              style={[st.tag, { borderColor: colors.line, backgroundColor: colors.primarySoft }]}>
              <Txt variant="chipSm" color={colors.primaryDeep}>
                {t}
              </Txt>
              <Icon name="x" size={s(11)} color={colors.primaryDeep} strokeWidth={2.8} />
            </Pressable>
          ))}
        </View>
      ) : null}

      {failure ? (
        <View style={st.failCard}>
          <Icon name="alert" size={s(18)} color={colors.danger} strokeWidth={2.4} />
          <Txt variant="bodyStrong" color={colors.danger} style={st.flex}>
            {failure}
          </Txt>
        </View>
      ) : null}

      {refused ? (
        <View style={st.emptyWrap}>
          <Mascot mood="asleep" size={sv(130)} />
          <Txt variant="display" style={st.emptyTitle}>
            Not transcribed
          </Txt>
          <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
            {/* Composed from the meeting's language, never read out of summary_line: that field
                says what a meeting was ABOUT, and a status message parked in it outlived the
                status — a recording refused once and transcribed later still led with "this
                sounds like Turkish". */}
            {unsupportedLanguageNote(meeting?.language)}
          </Txt>
          <Txt variant="sub" color={colors.inkDim} style={st.emptyBody}>
            Your recording is kept. Redo will transcribe it the day its language is supported.
          </Txt>
        </View>
      ) : empty ? (
        <View style={st.emptyWrap}>
          <Mascot mood="asleep" size={sv(130)} />
          <Txt variant="display" style={st.emptyTitle}>
            Nothing to show
          </Txt>
          <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
            Pip could not hear any speech in this recording. If the mic was covered or the room was
            very quiet, try again a little closer.
          </Txt>
        </View>
      ) : (
        <>
          <Segmented items={TABS} value={tab} onChange={setTab} style={st.tabs} />
          {/* Each tab owns its own scroll. Hosting them in one page scroll is what the split was
              for: the transcript can be a virtualised list only if it is the thing scrolling. */}
          <View style={st.flex}>
            {tab === 'summary' ? (
              <SummaryTab
                minutes={minutes}
                speakers={speakers}
                speechMs={speechMs}
                onWrite={() => onReprocess(true)}
                onOpenTab={setTab}
                onCopy={text => copyText(text, 'Summary')}
                edits={edits}
                onEdit={(initial, kind) =>
                  setEditing({
                    title: kind === 'summary' ? 'Correct the summary' : 'Correct the minutes',
                    hint: 'Your wording replaces what the model wrote. The original is kept, and you can put it back.',
                    initial,
                    multiline: true,
                    target: { kind, key: DOC_KEY },
                  })
                }
                onRevert={kind => onRevertEdit(kind, DOC_KEY)}
                onUpgrade={openPaywall}
                writing={reprocessing}
              />
            ) : tab === 'mom' ? (
              <MinutesTab
                minutes={minutes}
                onExport={onExport}
                onCopy={onCopy}
                edits={edits}
                onEditItem={onEditMinute}
                onRevertItem={key => onRevertEdit('minute', key)}
                onRemoveItem={onRemoveMinute}
                onAdd={onAddMinute}
                onEditNarrative={initial =>
                  setEditing({
                    title: 'Correct the minutes',
                    hint: 'Your wording replaces what the model wrote. The original is kept, and you can put it back.',
                    initial,
                    multiline: true,
                    target: { kind: 'narrative', key: DOC_KEY },
                  })
                }
                onRevertNarrative={() => onRevertEdit('narrative', DOC_KEY)}
              />
            ) : tab === 'transcript' ? (
              <TranscriptTab
                utterances={utterances}
                speakers={speakers}
                positionMs={player.positionMs}
                onPlayTurn={player.available ? player.playFrom : undefined}
                scrollToMs={atMs}
                onCopy={() => copyDoc('transcript', 'Transcript')}
                edits={edits}
                onEditLine={(id, initial) =>
                  setEditing({
                    title: 'Correct this line',
                    hint: 'Fixes a mis-heard word. The recording is untouched, and you can put the original back.',
                    initial,
                    multiline: true,
                    target: { kind: 'utterance', key: id },
                  })
                }
                onRevertLine={id => onRevertEdit('utterance', id)}
              />
            ) : (
              <ActionsTab
                meetingId={meetingId}
                minutes={minutes}
                edits={edits}
                onEditItem={onEditMinute}
                onRevertItem={key => onRevertEdit('minute', key)}
                onRemoveItem={onRemoveMinute}
                onAdd={onAddMinute}
              />
            )}
          </View>

          {/* Docked below the tabs rather than floating over them: it belongs to the meeting, not
              to whichever tab you happen to be on, and a floating bar covers the last line of the
              transcript — which is the line you are most often trying to read. Hidden outright
              when the audio has been swept, because a disabled play button just invites tapping. */}
          {player.available ? (
            <View style={{ paddingBottom: insets.bottom }}>
              {player.error ? (
                <Pressable onPress={player.dismissError} style={st.playerNote}>
                  <Icon name="alert" size={s(14)} color={colors.warning} strokeWidth={2.4} />
                  <Txt variant="chipSoft" color={colors.inkSoft} style={st.flex}>
                    {player.error}
                  </Txt>
                </Pressable>
              ) : null}
              <PlayerBar
                playing={player.playing}
                positionMs={player.positionMs}
                durationMs={player.durationMs || meeting?.durationMs || 0}
                onToggle={player.toggle}
                onSeek={player.seek}
              />
            </View>
          ) : null}
        </>
      )}

      <Sheet
        visible={sheet}
        title={meeting?.title || 'Meeting'}
        actions={sheetActions}
        onClose={() => setSheet(false)}
      />

      <TextPrompt
        visible={editing !== null}
        title={editing?.title ?? ''}
        hint={editing?.hint}
        initial={editing?.initial ?? ''}
        multiline={editing?.multiline}
        confirmLabel={editing?.confirmLabel}
        extraPlaceholder={editing?.extraPlaceholder}
        placeholder="Type here"
        onCancel={() => setEditing(null)}
        onSubmit={onSaveEdit}
      />

      <TextPrompt
        visible={tagging}
        title="Add a tag"
        hint="Tags are shared across meetings, so use the same word each time — “client”, “1:1”, “standup”."
        initial=""
        placeholder="Tag"
        confirmLabel="Add"
        onCancel={() => setTagging(false)}
        onSubmit={onAddTag}
      />

      <TextPrompt
        visible={renaming}
        title="Rename this meeting"
        hint="This is what you will see in the library, in search, and at the top of anything you export."
        initial={meeting?.title ?? ''}
        placeholder="Meeting name"
        onCancel={() => setRenaming(false)}
        onSubmit={onRename}
      />
    </View>
  );
}

/** The design's active-step ring: a 3px circle with one transparent edge, spinning. */
function Spinner({ size, color, track }: { size: number; color: string; track: string }) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 3,
        borderColor: track,
        borderTopColor: color,
        transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
      }}
    />
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    pad: { flex: 1, paddingHorizontal: s(22) },
    spacer: { flex: 1 },

    navRow: { flexDirection: 'row', alignItems: 'center', gap: s(12) },
    footer: { flexDirection: 'row', gap: s(10) },

    tagRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: s(6),
      paddingHorizontal: s(16),
      paddingBottom: s(8),
    },
    tag: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(6),
      paddingHorizontal: s(10),
      paddingVertical: s(5),
      borderRadius: radius.pill,
      borderWidth: 1,
    },
    playerNote: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(8),
      marginHorizontal: s(16),
      marginBottom: s(6),
      paddingHorizontal: s(12),
      paddingVertical: s(8),
      borderRadius: radius.ctl,
      backgroundColor: c.warningSoft,
    },
    failCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(10),
      backgroundColor: c.dangerSoft,
      borderRadius: radius.xl,
      padding: s(14),
      marginHorizontal: s(16),
      marginTop: s(4),
      marginBottom: s(10),
    },

    tabs: { marginHorizontal: s(16), marginBottom: s(10) },
    navRowDetail: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(12),
      paddingHorizontal: s(20),
    },

    procHead: { alignItems: 'center', marginTop: sv(26) },
    procTitle: { marginTop: s(18), textAlign: 'center' },
    procBody: { marginTop: s(6), textAlign: 'center', maxWidth: s(250) },
    pctPill: {
      marginTop: s(16),
      backgroundColor: c.primarySoft,
      paddingHorizontal: s(14),
      paddingVertical: s(8),
      borderRadius: radius.pill,
    },
    checkWrap: { marginTop: sv(26) },
    checkInner: { padding: s(8) },
    checkRow: { flexDirection: 'row', alignItems: 'center', gap: s(12), padding: s(14) },
    checkDot: { width: s(30), height: s(30), borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
    divider: { height: 1, backgroundColor: c.cardAlt, marginHorizontal: s(14) },



    // The bubble points at its speaker: the corner nearest the avatar is squared off.

    emptyWrap: { alignItems: 'center', paddingTop: sv(60), paddingHorizontal: s(30) },
    emptyTitle: { marginTop: s(18) },
    emptyBody: { textAlign: 'center', marginTop: s(8) },
  });
}
