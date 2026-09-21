import { unsupportedLanguageNote, forceTranscribePrompt, forcedTranscriptNote } from './languages';
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
import { highlightsFor, type Mark } from './meeting/highlights';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import { countsExcluding } from './threadData';
import { PipelineController } from '../pipeline/PipelineController';
import { entitlement, shouldOfferPaywall } from '../billing/trial';
import FileExport from '../native/NativeFileExport';
import Icon from '../components/Icon';
import Mascot from '../components/Mascot';
import { confirmDestructive, quoted } from '../components/confirm';
import {
  Badge,
  Button,
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
import TranscriptTab, { type Turn } from './meeting/TranscriptTab';
import SpeakerPicker from './meeting/SpeakerPicker';
import { linesForScope, nextSpeakerName, type Scope } from './meeting/speakerRepair';
import PlayerBar from './meeting/PlayerBar';
import { usePlayer } from './meeting/usePlayer';
import { proposeRule } from './meeting/vocabularyRule';
import type {
  EditTarget,
  Item,
  Meeting,
  Minute,
  MinuteKind,
  Speaker,
  Utterance,
} from '../pipeline/types';
import {
  DOC_KEY,
  composeAction,
  editKey,
  editTargetOf,
  isItemKind,
  toEditMap,
  type EditMap,
  type ItemRow,
} from './meeting/shared';
import { radius, s, sv, useTheme, type Colors } from '../theme';
import { STAGES, progressFor } from './progress';
import type { PauseReason } from '../pipeline/PipelineController';

type Props = NativeStackScreenProps<RootStackParamList, 'Meeting'>;


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
  const { meetingId, tab: initialTab, atMs, fromNotification } = route.params;

  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [minutes, setMinutes] = useState<Minute[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [speechMs, setSpeechMs] = useState(0);
  const [reprocessing, setReprocessing] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  /** The running stage's own counts, when it reports them; null after a stage change. */
  const [counts, setCounts] = useState<{ done: number; total: number } | null>(null);
  /** Seconds of work per second of audio, as this phone has measured them. */
  const [rates, setRates] = useState<Partial<Record<string, number>>>({});
  /** Why the pipeline is paused for the phone's sake, or null. Seeded for a screen opened mid-pause. */
  const [paused, setPaused] = useState<PauseReason | null>(PipelineController.pausedReason(meetingId) ?? null);
  const [failure, setFailure] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const [sheet, setSheet] = useState(false);
  // Summary unless the caller asked for somewhere specific. Nothing is REMEMBERED between visits:
  // tapping two meetings in a row and landing on different screens reads as a bug rather than a
  // convenience. A search hit is different — it knows where it is sending you, and why.
  const [tab, setTab] = useState<string>(initialTab ?? 'summary');

  /**
   * The moment the transcript has been asked to show, and WHICH ASKING it is.
   *
   * The sequence number is the whole reason this is an object. TranscriptTab's scroll effect is
   * keyed on the millisecond it is given, so asking twice for the same millisecond is not a change
   * and the second tap does nothing — and tapping the same item twice is the ordinary case, as is
   * tapping two items the rules pulled out of one turn. Bumping a counter on every request makes
   * every request distinct without pretending the moment moved.
   */
  const [scrollTo, setScrollTo] = useState<{ ms: number; seq: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagging, setTagging] = useState(false);
  const [edits, setEdits] = useState<EditMap>(new Map());
  /** Up to three of this meeting's tags with another meeting in their thread (Phase 3). */
  const [threads, setThreads] = useState<{ tag: string; open: number; decisions: number }[]>([]);

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
  /** The line whose long press opened the two-action sheet, with the turn it sits in. */
  const [lineSheet, setLineSheet] = useState<{ part: { id: string; text: string }; turn: Turn } | null>(null);
  /** The speaker picker: the line it is for, its turn, and whether the scope chips apply. */
  const [picker, setPicker] = useState<{ lineId: string; text: string; turn: Turn; scopes: boolean } | null>(null);
  /** "Someone new" is waiting for a name; remembers the scope chosen before the prompt. */
  const [naming, setNaming] = useState<{ scope: Scope } | null>(null);

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
   *
   * Not when the meeting was opened from the "Your notes are ready" notification. That notification
   * says "tap to see the summary and transcript", and on the Galaxy A07 the tap landed on this
   * sheet 900 ms later — a promise of notes answered with a price. The offer is not spent by that
   * visit: `shouldOfferPaywall` stays true until the sheet is actually shown, so it is made on the
   * next finished meeting the person opens from inside the app, which is a moment they chose.
   */
  useEffect(() => {
    if (meeting?.status !== 'done') return;
    if (fromNotification) return;
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
  }, [meeting?.status, openPaywall, fromNotification]);

  // `atMs` — the moment a search hit matched — only scrolls the transcript to that line; it does
  // NOT move the playhead. Seeking would mean opening the audio device merely to look at a search
  // result: it takes audio focus, and it fails outright while a recording is running, so opening
  // a hit mid-meeting would raise an error about playback nobody had asked for. The line is on
  // screen and one tap plays it, which is the whole of what the hit promised.
  //
  // `openProvenance` below DOES play, and that is not an inconsistency. Arriving from a search
  // hit is not a request to hear anything; pressing the play-and-timestamp on an item is nothing
  // else, and it cannot arrive mid-recording because it needs a meeting already open on screen.

  /**
   * Give this meeting its items, before anything reads them.
   *
   * A meeting recorded before the items table existed has none until `ensureItems` re-runs the
   * rule pass over its stored transcript. There IS a library-wide sweep now (Task 8b:
   * libraryStore.backfillItems, for the three cross-meeting views that cannot wait for each
   * meeting to be opened), and this call does not become redundant because of it: the sweep runs
   * on a Library focus in batches, and somebody who taps straight into a meeting from a
   * notification has not had one. So the call stays here, and it has to finish BEFORE the read
   * below — a just-migrated meeting whose items land after the first render draws a screen from
   * data that was not there yet.
   *
   * Once per opening, not once per refresh, and the difference matters for exactly the meeting
   * that needs watching: `refresh` is also a two-second poll while a meeting is being processed,
   * and `ensureItems`' guard includes "has utterances, has no items" — the state every meeting is in
   * between ASR finishing and the pipeline writing its items. A call per poll would re-run the
   * rule pass over a half-written transcript, over and over, on a phone already busy writing the
   * real one.
   *
   * A failure is swallowed and not retried here. What fails is loading the native core — a phone
   * still downloading libonnxruntime.so — and a meeting is readable whether or not it has been
   * migrated. `ensureItems` works out whether a meeting still needs migrating from the data rather
   * than from a flag, so the next open simply tries again.
   *
   * The two things a reader is likeliest to simplify, and why neither survives:
   *
   *  - The ref stores the `meetingId` it migrated. `useCallback` is re-created when the id
   *    changes, but the REF is not — it outlives every re-creation — so a bare
   *    `useRef<Promise<void> | null>` would have `refresh` await MEETING A's migration and then
   *    read meeting B. That is a live path, not a hypothetical: nothing sets `getId` on this
   *    screen, so `navigate('Meeting', …)` — a "Notes ready" notification for another meeting,
   *    tapped while this one is open — reuses this mounted screen and changes its params. It
   *    compiles either way; `a param change migrates the meeting now on screen` is the test.
   *  - The `.catch` sits on the promise as it is STORED, not on the await. `refresh()` is called
   *    with no handler of its own from the onComplete listener and from the floating `load()`, so
   *    catching at creation is what makes the stored promise unable to reject for ANY caller.
   *    `await migrate().catch(() => {})` reads as the same thing and leaves the other two callers
   *    awaiting a rejected promise.
   */
  const migration = useRef<{ meetingId: string; done: Promise<void> } | null>(null);
  const migrate = useCallback(() => {
    if (migration.current?.meetingId !== meetingId) {
      migration.current = { meetingId, done: db.ensureItems(meetingId).catch(() => {}) };
    }
    return migration.current.done;
  }, [meetingId]);

  const refresh = useCallback(async () => {
    await migrate();
    const [mtg, mins, its, utts, segs, spk, eds, tgs, mks, rts] = await Promise.all([
      db.getMeeting(meetingId),
      db.minutes(meetingId),
      // After `migrate()`, so a meeting recorded before items existed has been given them. A
      // failure there is swallowed on purpose and leaves this empty, which the tabs handle by
      // falling back to the minutes — see toItemRows.
      db.items(meetingId).catch(() => []),
      db.utterances(meetingId),
      db.segments(meetingId),
      db.speakers(meetingId),
      db.edits(meetingId).catch(() => []),
      db.tagsFor(meetingId).catch(() => []),
      db.marks(meetingId).catch(() => []),
      db.stageRates().catch(() => ({})),
    ]);
    setMeeting(mtg ?? null);
    setRates(rts);
    setMinutes(mins);
    setItems(its);
    setUtterances(utts);
    setSpeakers(spk);
    setEdits(toEditMap(eds));
    setTags(tgs);
    setMarks(mks);
    setSpeechMs(segs.reduce((a, x) => a + (x.end_ms - x.start_ms), 0));
    // "Is there anything written about this meeting yet", which is the SAME question
    // `nothingWritten` asks below and the poll under this hook stops on. It returned `mins.length`,
    // and that was right only while every decision and action lived in `minutes` too: a meeting
    // whose rules extracted nothing and that somebody typed a decision into now answers 0, so the
    // screen re-runs all eight bridge queries every two seconds for two minutes after every open,
    // re-setting seven pieces of state and re-running three `toItemRows` memos each time. Nothing
    // looks wrong — `working` and `empty` read both tables — it is silent waste on the phone.
    return mins.length + its.length;
  }, [meetingId, migrate]);

  // Marks are moments; the words at each moment are resolved here, at render time, so a
  // reprocess that rewrites the transcript never touches the mark — see highlightsFor.
  const highlights = useMemo(() => highlightsFor(marks, utterances), [marks, utterances]);

  const voiceSuggestions = useMemo(
    () => speakers.map(sp => sp.suggestedName).filter((n): n is string => !!n),
    [speakers],
  );

  /**
   * The Summary tab's thread lines (Phase 3): up to three of this meeting's tags, alphabetical —
   * `tags` is already in that order (AudioDb.tagsFor's ORDER BY name) — each resolved to counts
   * that EXCLUDE this meeting's own rows, so the line says what is earlier, not what this meeting
   * itself just produced. A tag whose thread has no other meeting, or a `NOT_PRO` refusal, drops
   * out via countsExcluding rather than being shown as zero.
   */
  useEffect(() => {
    let alive = true;
    if (tags.length === 0) {
      setThreads([]);
      return;
    }
    Promise.all(tags.slice(0, 3).map(tag => db.thread(tag).then(r => ({ tag, counts: countsExcluding(meetingId, r) }))))
      .then(rows => {
        if (!alive) return;
        setThreads(
          rows
            .filter((r): r is { tag: string; counts: { open: number; decisions: number } } => r.counts !== null)
            .map(r => ({ tag: r.tag, ...r.counts })),
        );
      })
      .catch(() => {
        if (alive) setThreads([]);
      });
    return () => {
      alive = false;
    };
  }, [tags, meetingId]);
  const onRemoveMark = useCallback(
    (id: number) => {
      db.removeMark(id)
        .then(() => refresh())
        .catch(() => {});
    },
    [refresh],
  );

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

  /**
   * Reload when the screen comes BACK into focus.
   *
   * The Speakers screen is a separate route that writes to the same meeting — a rename lands in
   * the database the moment editing ends — and this screen used to load once on mount and again
   * only when the pipeline finished. So on the Pixel a speaker renamed to "Dr Sen" still read
   * "Speaker 1" on the transcript until the meeting was closed and reopened. The first focus is
   * the mount, which the load above already covers; every later one is a return from somewhere
   * that may have changed the data.
   */
  useEffect(() => {
    let mounted = false;
    const off = navigation.addListener('focus', () => {
      if (!mounted) {
        mounted = true;
        return;
      }
      refresh();
    });
    return off;
  }, [navigation, refresh]);

  useEffect(() => {
    const offProgress = PipelineController.onProgress(p => {
      if (p.meetingId !== meetingId) return;
      setStage(p.stage);
      // 0/1 and 1/1 are "started" and "finished", not counts; only a total above 1 is progress.
      setCounts(p.total > 1 ? { done: p.chunk, total: p.total } : null);
    });
    const offPause = PipelineController.onPause(e => {
      if (e.meetingId === meetingId) setPaused(e.reason);
    });
    const offComplete = PipelineController.onComplete(e => {
      if (e.meetingId !== meetingId) return;
      setPaused(null);
      setStage(null);
      setSettled(true);
      if (e.outcome === 'error') setFailure(e.message ?? 'Processing failed');
      refresh();
    });
    return () => {
      offProgress();
      offPause();
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
   * Overrule a refusal we may have got wrong.
   *
   * Stamps the meeting FIRST, then reprocesses: ProcessingEngine reads the column at the top of
   * its ASR stage, so the order matters — reprocessing first would run the same detection, refuse
   * again, and the button would look broken.
   *
   * The heard language is passed from the row we are looking at, because the successful run
   * overwrites `language` with the requested code and there would be nothing left to name.
   */
  const onTranscribeAnyway = useCallback(() => {
    const prompt = forceTranscribePrompt(meeting?.language);
    Alert.alert(prompt.title, prompt.body, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Transcribe anyway',
        style: 'destructive',
        onPress: async () => {
          await db.markTranscribeForced(meetingId, meeting?.language ?? null);
          await refresh();
          await onReprocess();
        },
      },
    ]);
  }, [meeting?.language, meetingId, onReprocess, refresh]);

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
   * A person's pick from the Summary tab's type sheet (Phase 2, sub-project 6a). Always writes
   * template + template_source = 'chosen' and remembers it for every one of the meeting's tags,
   * on free the same as on Pro — SummaryTab decides for itself whether to also call onWrite, so
   * this never triggers "Write it again" on its own.
   */
  const onChangeTemplate = useCallback(
    async (id: string) => {
      setMeeting(m => (m ? { ...m, template: id, templateSource: 'chosen' } : m));
      try {
        await db.setTemplate(meetingId, id);
        await db.rememberTemplateForTags(meetingId, id);
      } catch (e: any) {
        Alert.alert('Could not change the meeting type', String(e?.message ?? e));
        refresh();
      }
    },
    [meetingId, refresh],
  );

  /**
   * Phase 5: a correction that is one substitution of one to three words — "in over" → "Innova" —
   * is offered once as a rule. Yes stores it as `learned` and re-runs the rules over this meeting;
   * No stores nothing. Pro only: a free user's correction stays a correction. `proposeRule` decides
   * what counts; this only asks.
   */
  const offerRule = useCallback(
    async (before: string, after: string) => {
      const rule = proposeRule(before, after);
      if (!rule) return;
      const ent = await entitlement().catch(() => null);
      if (!ent?.paid) return;
      Alert.alert(
        `Always write “${rule.meant}” when it hears “${rule.heard}”?`,
        'Applies to the rest of this meeting and to every recording after it. Change or remove it in Settings › Vocabulary.',
        [
          { text: 'No', style: 'cancel' },
          {
            text: 'Yes',
            onPress: () => {
              db.putVocabulary(rule.heard, rule.meant, 'learned')
                .then(() => db.applyVocabulary(meetingId))
                .then(() => refresh())
                .catch(() => {});
            },
          },
        ],
      );
    },
    [meetingId, refresh],
  );

  /**
   * Save a correction, or a newly typed item.
   *
   * Corrections go into the `edits` side table rather than over the text they correct, because
   * reprocessing owns and rewrites the `rule` rows and would overwrite a person's words on the
   * next pass. A side row survives that and makes revert a single delete. `spec.target` says where
   * it is keyed — [editTargetOf] for an item row, `DOC_KEY` for the summary and the write-up, the
   * utterance id for a transcript line — and this handler never invents one.
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
          // THE SPLIT IS THE KIND. A decision, action or open question is a list row and goes to
          // `items`, where it gains a stable id — so its tick lives in `item_done` and its
          // correction in `edits` keyed on that id, and both survive a reprocess re-wording the
          // line. A summary, narrative or headline is a DOCUMENT: one per meeting, no anchor, no
          // tick, no provenance, and `items` has nothing to offer it, so it stays prose in
          // `minutes`. ITEM_KINDS is the one list either side is written from.
          // `isItemKind` NARROWS, so neither call needs a cast — and a mutant that routed every
          // add to `addUserItem` stops compiling rather than shipping prose into the list tables.
          if (isItemKind(spec.add)) {
            await db.addUserItem(meetingId, spec.add, content);
          } else {
            await db.addUserMinute(meetingId, spec.add, content);
          }
          await refresh();
          return;
        }
        if (!spec.target) return;
        const { kind, key } = spec.target;
        // Optimistic, and cheap to be: the row is on screen and the map is the only thing the
        // render reads. A failed write is put right by the refresh in the catch.
        setEdits(prev => new Map(prev).set(editKey(kind, key), value));
        await db.putEdit(meetingId, kind, key, value);
        if (kind === 'utterance') void offerRule(spec.initial, value);
      } catch (e: any) {
        Alert.alert('Could not save that', String(e?.message ?? e));
        refresh();
      }
    },
    [editing, meetingId, refresh, offerRule],
  );

  /** Drop a correction, restoring whatever the pipeline wrote. */
  const onRevertEdit = useCallback(
    async (kind: EditTarget, key: string) => {
      setEdits(prev => {
        const next = new Map(prev);
        next.delete(editKey(kind, key));
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

  /**
   * Remove a row the person added. Only ever reachable on a row `toItemRows` marked `mine`.
   *
   * DISPATCHED ON THE ROW, not on an id, because two stores can hold one of these. A hand-typed
   * decision is an `items` row as of Task 12 and is deleted by its item id; a hand-typed row on a
   * meeting whose migration has not run is still a `minutes` row and is deleted by that. Handing
   * this an id would mean the tab deciding which store it came from, and the tab is exactly the
   * place that must not know — see [editTargetOf], which answers the same question for
   * corrections.
   *
   * Both writers are scoped to the person's own rows in SQL (`gen_version='user'`,
   * `source='user'`), so a stale row id cannot delete something the rules produced.
   */
  const onRemoveRow = useCallback(
    async (row: ItemRow) => {
      try {
        if (row.itemId) await db.removeUserItem(meetingId, row.itemId);
        else if (row.minuteId) await db.deleteUserMinute(meetingId, row.minuteId);
        else return;
        await refresh();
      } catch (e: any) {
        Alert.alert('Could not remove that', String(e?.message ?? e));
      }
    },
    [meetingId, refresh],
  );

  /**
   * Open the prompt on one item — the correction path shared by the MOM and Actions tabs.
   *
   * Keyed by [editTargetOf] and never by anything computed here: an extracted row is corrected on
   * its `items.id`, a row that has no item on the hash of its STORED text — never on what is
   * displayed, which is already the correction on a second edit. The Kotlin export renderer reads
   * exactly these two keys off the database, so a writer that disagreed with it would save a
   * correction the exported document could never find, and nothing would report it.
   */
  const onEditRow = useCallback(
    (row: ItemRow) => {
      const target = editTargetOf(row);
      setEditing({
        title: 'Correct this line',
        hint: 'Your wording replaces what the app wrote. The original is kept, and you can put it back.',
        initial: edits.get(editKey(target.kind, target.key)) ?? row.text,
        multiline: true,
        target,
      });
    },
    [edits],
  );

  /** Undo a correction, wherever this row's correction happens to live. */
  const onRevertRow = useCallback(
    (row: ItemRow) => {
      const target = editTargetOf(row);
      onRevertEdit(target.kind, target.key);
    },
    [onRevertEdit],
  );

  /**
   * Open an item's evidence: switch to the transcript, scroll to the anchor, play from it.
   *
   * The tab switch and the scroll are NOT guarded on `player.available` and the play call is. A
   * meeting whose recording has been discarded keeps its transcript and its item anchors — the
   * rule pass runs over stored text and needs no audio at all — so the checkable half of this
   * feature survives retention, and only the listening half goes. Hiding the link then would
   * punish somebody for a setting they chose.
   *
   * The sequence bump is what makes tapping the same item twice work; see `scrollTo` above.
   */
  const openProvenance = useCallback(
    (ms: number) => {
      setTab('transcript');
      setScrollTo(prev => ({ ms, seq: (prev?.seq ?? 0) + 1 }));
      if (player.available) player.playFrom(ms);
    },
    [player],
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
  // The format list was an Alert with five buttons. Android's alert shows THREE: on the Pixel the
  // dialog offered PDF, Markdown and Plain text, and "Subtitles (.srt)" and "Cancel" were never
  // rendered — so the subtitle export the menu promised was unreachable, and the dialog could not
  // be backed out of. The app's own sheet has no such limit and carries a line per row.
  const [exportSheet, setExportSheet] = useState(false);
  const onExport = () => setExportSheet(true);
  /**
   * Who said these lines. Splitting and merging turns are both this: the scope picks the ids,
   * setLineSpeaker writes through and records the edit, and the Script regroups on refresh.
   */
  const applySpeaker = useCallback(
    async (speakerId: string, scope: Scope) => {
      if (!picker) return;
      const ids = linesForScope(picker.turn, picker.lineId, scope);
      setPicker(null);
      if (ids.length === 0) return;
      await db.setLineSpeaker(meetingId, ids, speakerId).catch(() => {});
      refresh();
    },
    [picker, meetingId, refresh],
  );
  const onSomeoneNew = useCallback((scope: Scope) => setNaming({ scope }), []);
  const onNamed = useCallback(
    async (name: string) => {
      const scope = naming?.scope ?? 'line';
      setNaming(null);
      const sp = await db
        .addSpeaker(meetingId, name.trim() || nextSpeakerName(speakers.map(x => x.displayName)))
        .catch(() => null);
      if (sp) await applySpeaker(sp.id, scope);
    },
    [naming, meetingId, speakers, applySpeaker],
  );

  const exportActions: SheetAction[] = [
    { icon: 'share', label: 'PDF', hint: 'The one that looks the same wherever it lands.',
      onPress: () => FileExport.share(meetingId, 'pdf') },
    { icon: 'copy', label: 'Markdown', hint: 'For notes apps and wikis.',
      onPress: () => FileExport.share(meetingId, 'md') },
    { icon: 'copy', label: 'Plain text', hint: 'For anything else.',
      onPress: () => FileExport.share(meetingId, 'txt') },
    { icon: 'share', label: 'Subtitles (.srt)', hint: 'The transcript, timed, for a video editor.',
      onPress: () => FileExport.share(meetingId, 'srt') },
  ];

  // A recording we declined to transcribe is FINISHED, not in flight. Without this it fell through
  // to the progress view and span on "Writing your notes..." forever, because nothing was running
  // to ever report completion — and once that was fixed it fell through again to "could not hear
  // any speech", which is a different and untrue explanation. Cleared the moment a reprocess
  // starts, so Redo shows real progress.
  const refused =
    meeting?.status === 'unsupported_language' && !reprocessing && stage === null;
  // "Has this meeting anything written about it", asked of BOTH tables — the same correction the
  // Summary tab's counters needed, on the guard that decides whether the tabs are drawn at all.
  //
  // It was `minutes.length === 0`, and that was right only while every decision and action lived
  // in `minutes` as well as in `items`. A meeting whose rules extracted nothing and that somebody
  // then typed a decision into now has ONE row and it is an `items` row: asked of `minutes` alone
  // this screen answers "nothing here", and the person is shown "Writing your notes…" — or "could
  // not hear any speech" — over the note they typed themselves. Before Task 12 that same note was
  // a `minutes` row and the tabs were drawn.
  const nothingWritten = minutes.length === 0 && items.length === 0;
  const working = !refused && (stage !== null || reprocessing || (!settled && nothingWritten));
  const empty = !refused && settled && !working && nothingWritten && utterances.length === 0;

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
      icon: 'chat',
      label: 'Ask this meeting',
      hint: 'A question, answered from the transcript, with the moments it came from.',
      onPress: () => navigation.navigate('Ask', { meetingId }),
    },
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
    // `stage` is null until an event arrives, and opening a meeting that is ALREADY processing
    // is the common case — so the persisted status decides, rather than assuming the first stage.
    // Assuming was the bug: a 90-minute meeting showed stage one for 78 minutes because the next
    // event was half an hour away. See src/screens/progress.ts.
    const { index: idx, pct, etaSec: eta } = progressFor({
      liveStage: stage,
      status: meeting?.status,
      audioSec: (meeting?.durationMs ?? 0) / 1000,
      rates,
      fraction: counts ? counts.done / counts.total : undefined,
    });

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
              {paused ? 'Paused for a moment' : 'Writing your notes…'}
            </Txt>
            {/* No ETA while paused: a time that is not counting down is a promise, not an estimate. */}
            <Txt variant="sub" color={colors.inkDim} style={st.procBody}>
              {paused === 'heat'
                ? 'Paused to let the phone cool — it resumes on its own.'
                : paused === 'battery'
                  ? 'Paused until the phone is charging or has more battery.'
                  : 'All the thinking happens on your phone, so it takes a moment.'}
            </Txt>
            <View style={st.pctPill}>
              <Txt variant="metaBlack" color={colors.primary}>
                {pct}%{paused ? '' : etaLabel(eta)}
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
                        ) : state === 'active' && !paused ? (
                          <Spinner size={s(30)} color={colors.primary} track="#DDE1F5" />
                        ) : state === 'active' ? (
                          <View style={[st.checkDot, { backgroundColor: colors.warningSoft }]}>
                            <Icon name="pause" size={s(16)} color={colors.warning} strokeWidth={2.6} />
                          </View>
                        ) : (
                          <View style={[st.checkDot, { backgroundColor: colors.cardAlt }]} />
                        )}
                        <Txt
                          variant={state === 'active' ? 'bodyBlack' : 'bodyStrong'}
                          color={state === 'active' ? colors.primary : state === 'todo' ? colors.inkDim : colors.ink}>
                          {x.label}
                          {state === 'active' && counts ? ` · ${counts.done} of ${counts.total}` : ''}
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
        <Sheet
          visible={exportSheet}
          title="Export minutes"
          actions={exportActions}
          onClose={() => setExportSheet(false)}
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
            {(meeting?.mode === 'dictation' ? 'Dictation · ' : '') +
              (meeting?.createdAt
                ? new Date(meeting.createdAt).toLocaleString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  })
                : '')}
          </Txt>
        </Pressable>
        {meeting?.status === 'done' ? (
          <Badge label="READY" color={colors.success} soft={colors.successSoft} small />
        ) : null}
        <IconButton icon="chat" label="Ask this meeting" onPress={() => navigation.navigate('Ask', { meetingId })} />
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
          {/* The only route onward used to be Redo, buried in the overflow sheet — which re-runs
              the same detection and lands back here. An action that appears to do nothing is
              worse than no action, and detection can be wrong: a real English meeting was heard
              as Turkish at p=0.88 on a Galaxy A07. */}
          <Button
            label="Transcribe it anyway"
            onPress={onTranscribeAnyway}
            style={st.emptyAction}
          />
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
          {/* Not dismissible: its whole purpose is to outlive the moment of the decision. The
              person who forced it knew; the person reading it three weeks later did not. */}
          {meeting?.transcribeForcedAt ? (
            <View style={st.forcedBanner}>
              <Txt variant="sub" color={colors.warning}>
                {forcedTranscriptNote(meeting?.forcedFromLanguage)}
              </Txt>
            </View>
          ) : null}
          {/* Diarization is best-effort and this is what that costs when the phone cannot afford
              it. Read from the meeting rather than composed here: the sentence has to describe the
              run that made the decision, not the memory the phone happens to have now. Not a
              warning colour — nothing went wrong, a stage was declined so the meeting survived. */}
          {meeting?.diarSkippedReason ? (
            <View style={st.forcedBanner}>
              <Txt variant="sub" color={colors.inkSoft}>
                {meeting.diarSkippedReason}
              </Txt>
            </View>
          ) : null}
          <Segmented items={TABS} value={tab} onChange={setTab} style={st.tabs} />
          {/* Each tab owns its own scroll. Hosting them in one page scroll is what the split was
              for: the transcript can be a virtualised list only if it is the thing scrolling. */}
          <View style={st.flex}>
            {tab === 'summary' ? (
              <SummaryTab
                items={items}
                minutes={minutes}
                speakers={speakers}
                speechMs={speechMs}
                highlights={highlights}
                onOpenProvenance={openProvenance}
                onReview={() => navigation.navigate('Review', { meetingId })}
                canPlay={player.available}
                onRemoveMark={onRemoveMark}
                onWrite={() => onReprocess(true)}
                template={meeting?.template}
                onChangeTemplate={onChangeTemplate}
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
                threads={threads}
                 onOpenThread={tag => navigation.navigate('Thread', { tag })}
                 voiceSuggestions={voiceSuggestions}
                 onConfirmVoices={() => navigation.navigate('Speakers', { meetingId })}
               />
            ) : tab === 'mom' ? (
              <MinutesTab
                items={items}
                minutes={minutes}
                onExport={onExport}
                onCopy={onCopy}
                edits={edits}
                onEditItem={onEditRow}
                onRevertItem={onRevertRow}
                onRemoveItem={onRemoveRow}
                onAdd={onAddMinute}
                onOpenProvenance={openProvenance}
                canPlay={player.available}
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
                // Two sources, one prop. `atMs` is where a search hit sent us and is fixed for the
                // life of the screen; `scrollTo` is somewhere an item on another tab asked for, and
                // it wins from the moment it exists because it is the later request of the two.
                scrollToMs={scrollTo ? scrollTo.ms : atMs}
                scrollSeq={scrollTo?.seq}
                onCopy={() => copyDoc('transcript', 'Transcript')}
                edits={edits}
                onLineActions={(part, turn) => setLineSheet({ part, turn })}
                onReassignTurn={turn =>
                  setPicker({ lineId: turn.parts[0].id, text: turn.parts[0].text, turn, scopes: false })
                }
                onRevertLine={id => onRevertEdit('utterance', id)}
              />
            ) : (
              <ActionsTab
                meetingId={meetingId}
                items={items}
                minutes={minutes}
                edits={edits}
                onEditItem={onEditRow}
                onRevertItem={onRevertRow}
                onRemoveItem={onRemoveRow}
                onAdd={onAddMinute}
                onOpenProvenance={openProvenance}
                canPlay={player.available}
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

      <Sheet
        visible={exportSheet}
        title="Export minutes"
        actions={exportActions}
        onClose={() => setExportSheet(false)}
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

      {/* Long press on a line: the two things a person can do to it. Sheet closes itself before
          calling the action, so the prompt or the picker opens over a clean screen. */}
      <Sheet
        visible={lineSheet !== null}
        title={lineSheet ? lineSheet.part.text : undefined}
        actions={[
          {
            icon: 'edit',
            label: 'Correct the words',
            hint: 'Fixes a mis-heard word. The recording is untouched.',
            onPress: () => {
              if (!lineSheet) return;
              setEditing({
                title: 'Correct this line',
                hint: 'Fixes a mis-heard word. The recording is untouched, and you can put the original back.',
                initial: lineSheet.part.text,
                multiline: true,
                target: { kind: 'utterance', key: lineSheet.part.id },
              });
            },
          },
          {
            icon: 'users',
            label: 'Change who said it',
            hint: 'This line, the rest of the turn, or the whole turn.',
            onPress: () => {
              if (!lineSheet) return;
              setPicker({
                lineId: lineSheet.part.id,
                text: lineSheet.part.text,
                turn: lineSheet.turn,
                scopes: lineSheet.turn.parts.length > 1,
              });
            },
          },
        ]}
        onClose={() => setLineSheet(null)}
      />
      <SpeakerPicker
        visible={picker !== null && naming === null}
        lineText={picker?.text ?? ''}
        speakers={speakers}
        currentId={picker ? utterances.find(u => u.id === picker.lineId)?.speakerId ?? null : null}
        scopes={picker?.scopes ?? false}
        onPick={applySpeaker}
        onNew={onSomeoneNew}
        onClose={() => setPicker(null)}
      />
      <TextPrompt
        visible={naming !== null}
        title="Who is this?"
        hint="A name for a voice the app did not separate. You can rename or merge it later on the Speakers screen."
        initial=""
        placeholder="Name"
        confirmLabel="Add"
        onCancel={() => setNaming(null)}
        onSubmit={onNamed}
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
    emptyAction: { marginTop: s(20), alignSelf: 'center' },
    forcedBanner: {
      backgroundColor: c.warningSoft,
      borderRadius: s(10),
      paddingHorizontal: s(12),
      paddingVertical: s(10),
      marginHorizontal: s(16),
      marginBottom: s(8),
    },
  });
}
