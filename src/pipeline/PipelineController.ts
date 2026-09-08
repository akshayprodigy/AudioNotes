// JS-side orchestrator. It does NOT do any heavy work — it starts/stops capture,
// kicks off native processing, listens to native progress events, and reflects them
// into app state. All ASR/diarization/LLM work happens off-thread in native/C++.
import { NativeEventEmitter, NativeModules } from 'react-native';
import AudioPipeline from '../native/NativeAudioPipeline';
import { entitlement } from '../billing/trial';
import { capMsFor } from '../billing/recordingCap';
import Storage from '../native/NativeStorage';
import { db } from '../db/queries';
import { extractMinutes } from './minutes';
import type { PipelineOutcome, StageProgress, Utterance } from './types';

type ProgressCb = (p: StageProgress) => void;

/** Default window when nothing has been chosen: a week, long enough to check a transcript against
 *  what was actually said, short enough that a phone does not quietly fill up with raw meetings. */
export const DEFAULT_RETENTION_DAYS = 7;

/**
 * How long a meeting's raw PCM is kept, in days. -1 means "until I delete the meeting".
 *
 * Two settings feed this because the app shipped with the other one first. `keepAudio` was a
 * boolean — on meant forever, off meant delete the moment a transcript existed — and deleting
 * immediately is what made playback impossible for every meeting anyone had recorded. The
 * replacement is a window in days, so `audioRetentionDays` wins wherever it has been written and
 * `keepAudio` only decides the default for an install that predates it. An old install that had
 * explicitly asked to keep audio still keeps it; everyone else moves from "gone instantly" to a
 * week, which is the promise the Settings copy now makes.
 *
 * Kept deliberately identical to the Kotlin resolution in ProcessingEngine/AudioDb — native does
 * the deleting, and a window that disagreed with the one the app displays would delete audio the
 * user had been told was still there.
 */
export function resolveRetentionDays(
  audioRetentionDays: string | null | undefined,
  keepAudio: string | null | undefined,
): number {
  const raw = (audioRetentionDays ?? '').trim();
  if (raw !== '') {
    const n = Number(raw);
    // Number('') is 0 and Number('7 days') is NaN, so both are screened out before this point:
    // a malformed setting must fall through to the legacy default rather than silently mean
    // "delete everything now".
    if (Number.isInteger(n)) return n < 0 ? -1 : n;
  }
  return keepAudio === '1' ? -1 : DEFAULT_RETENTION_DAYS;
}

/**
 * Whether the pipeline may replace this meeting's title with one written from the transcript.
 *
 * `titleEditedAt` is stamped by db.setTitle whenever a PERSON renames a meeting, and it is the
 * only reliable half of this guard. The string sniff below cannot tell the app's own placeholder
 * from a real title that happens to look like one — "Tuesday standup meeting · notes" is a
 * perfectly ordinary thing to type, and the retitle runs on EVERY pass over a meeting that is not
 * yet 'done', not only on an explicit reprocess, so a title like that was overwritten silently and
 * repeatedly. The sniff stays as the secondary check because meetings titled before the column
 * existed have no stamp at all, and their placeholders should still be improved.
 *
 * Mirrored exactly by ProcessingEngine.retitleFromTranscript in Kotlin — native finishes meetings
 * that JS never sees (stopped from the PiP window or the notification), so a guard that existed on
 * only one side would protect a renamed meeting only when the app happened to be open.
 */
export function shouldAutoRetitle(
  current: string,
  titleEditedAt: number | null | undefined,
): boolean {
  if (titleEditedAt != null && titleEditedAt > 0) return false;
  return current === 'Meeting' || / meeting · /.test(current);
}

/**
 * The words a meeting actually opens with, minus the ones that carry no information.
 *
 * Auto-titles are the transcript's opening, and meetings open with throat-clearing: "So there are
 * three different stages to the design" — a real title off a real recording, where the first word
 * is the only one a reader has to skip. The review named this ("Okay so um yeah let's start…") and
 * it is the first thing anybody sees in the library.
 *
 * Only leading filler goes, one word at a time, and only while a substantial title survives —
 * gutting a short opening to three words would be a worse row than the one it replaces. This is
 * cosmetic by design: the real fix for a bad title is the Rename item in the meeting menu, and
 * the point here is that the default should not need it as often.
 *
 * MIRRORED in ProcessingEngine.kt (stripOpeningFiller). Android titles headlessly through the
 * native path, so a change here that is not made there means the same recording gets a different
 * name depending on which one processed it.
 */
const OPENING_FILLER =
  /^(so|okay|ok|um|uh|erm|ah|oh|right|yeah|yep|yes|well|alright|anyway|now|and|but|like|basically|actually)\b[,]?\s+/i;

export function stripOpeningFiller(opening: string): string {
  let out = opening;
  // A floor, not a nicety: without it "So, right" becomes "" and the meeting loses its name.
  while (out.length > 15) {
    const next = out.replace(OPENING_FILLER, '');
    if (next === out || next.length < 15) break;
    out = next;
  }
  return out;
}

class PipelineControllerImpl {
  private emitter = new NativeEventEmitter(NativeModules.AudioPipeline);
  private subs: { remove(): void }[] = [];

  /**
   * Start capturing.
   *
   * The cap is resolved HERE rather than by the caller, so every entry point — the record screen,
   * the Quick Settings tile, the notification — gets the same limit. A tile that recorded without
   * one would be a free unlimited recorder with a different button.
   */
  async startRecording(language: string | null): Promise<string> {
    const ent = await entitlement().catch(() => null);
    const capMs = capMsFor(Boolean(ent?.paid));
    return AudioPipeline.start({ sampleRate: 16000, language, capMs });
  }

  async stopRecording(sessionId: string): Promise<void> {
    return AudioPipeline.stop(sessionId);
  }

  // Live capture state owned by native (see NativeAudioPipeline.currentSession).
  async currentSession() {
    return AudioPipeline.currentSession();
  }

  async setPaused(paused: boolean): Promise<boolean> {
    return AudioPipeline.setPaused(paused);
  }

  // AudioPipeline.process() is fire-and-forget: it enqueues the meeting into the foreground
  // service and resolves immediately, so the heavy stages run AFTER this call returns. We await
  // the service's terminal event so callers can rely on process() resolving only once the meeting
  // is finished.
  //
  // Every stage is native now, narration included (ProcessingEngine -> Narrator). JS used to add
  // the LLM pass on top here, which meant a meeting stopped from the PiP window or the
  // notification — with no app in the foreground and no JS alive — never got one. It also meant
  // two code paths wrote the same rows.
  //
  // `force` is passed straight through to native. It marks narration outstanding again WITHOUT
  // deleting the prose that is already there — "Write it again" used to clear the summary first so
  // the resume plan would find work to do, which meant a rewrite that could not run (entitlement
  // lapsed, model uninstalled, the process killed for memory) destroyed the summary it was meant
  // to replace and left the meeting with nothing.
  async process(
    meetingId: string,
    opts: { model: 'base' | 'small'; force?: boolean },
  ): Promise<void> {
    await this.awaitNativeComplete(meetingId, () => AudioPipeline.process(meetingId, opts));
  }

  /**
   * Resolve when the service reports this meeting's terminal outcome (done | cancelled | error).
   * `kick` starts native processing (now fire-and-forget) — if it throws synchronously we resolve
   * 'error' so the caller never hangs. If the app is killed mid-run, this promise simply never
   * settles (the process is gone); the next Library sweep finishes the meeting.
   */
  private awaitNativeComplete(meetingId: string, kick: () => Promise<void>): Promise<PipelineOutcome> {
    return new Promise<PipelineOutcome>(resolve => {
      const off = this.onComplete(e => {
        if (e.meetingId === meetingId) {
          off();
          resolve(e.outcome);
        }
      });
      kick().catch(() => {
        off();
        resolve('error');
      });
    });
  }

  /**
   * Delete a meeting and everything belonging to it — audio, transcript, minutes, search index.
   *
   * Order matters. Cancelling first stops a run that is mid-pipeline from writing utterances back
   * against a row that is about to disappear (and, worse, from being handed a meeting id that no
   * longer resolves). The audio is unlinked before the row goes, because the row is the only place
   * its path is recorded — dropping it first would leak an unencrypted PCM file on disk forever.
   *
   * This is the one irreversible action in the app, so callers must confirm first.
   */
  async deleteMeeting(meetingId: string): Promise<void> {
    try {
      AudioPipeline.cancel(meetingId);
    } catch {
      // Nothing in flight for this meeting; deleting it is still correct.
    }
    this.inFlight.delete(meetingId);
    try {
      await AudioPipeline.discardAudio(meetingId);
    } catch {
      // Already gone, or unlink failed. Neither is a reason to keep the row.
    }
    await db.deleteMeeting(meetingId);
  }

  /**
   * Process any meeting that still owes work — recorded from the PiP window or the Quick Settings
   * tile with the app never opened, or abandoned part-way by a process kill. Called on app open
   * and on Library focus.
   *
   * Re-entrancy is the thing to be careful about here. LibraryScreen runs this on mount AND on
   * every focus, and a single pass can take tens of minutes, so without a guard two passes
   * overlap and transcribe the same meeting twice concurrently — double the CPU, and two racing
   * writers for one meeting's rows. `sweeping` collapses concurrent callers onto one pass;
   * `inFlight` additionally keeps the resumable-status query (which cannot distinguish "stalled
   * in vad" from "in vad right now") from re-entering a meeting this session is already doing.
   */
  private sweeping: Promise<void> | null = null;
  private inFlight = new Set<string>();

  processPending(): Promise<void> {
    if (!this.sweeping) {
      this.sweeping = this.sweep().finally(() => {
        this.sweeping = null;
      });
    }
    return this.sweeping;
  }

  private async sweep(): Promise<void> {
    // First rescue anything stranded in 'recording' by a mid-capture process kill — those rows
    // become 'captured' and are picked up by the same pass below. Without this their audio sits
    // on disk untranscribed forever.
    try {
      const n = await AudioPipeline.recoverOrphans();
      if (n > 0) console.warn(`[pipeline] recovered ${n} interrupted recording(s)`);
    } catch {
      // recovery is best-effort; never block normal processing on it
    }
    await this.sweepRetention();
    await this.backfillSearch();
    const pending = await db.pendingMeetings();
    for (const m of pending) {
      if (this.inFlight.has(m.id)) continue;
      this.inFlight.add(m.id);
      try {
        // Always route through process() -> the native service. Its status-aware completion gate
        // resumes only the missing stages (ResumePlan) — a meeting whose rows already exist but
        // whose status isn't 'done' has just its minutes step re-run natively, so this no longer
        // needs a JS-side shortcut for the "utterances + speakers already present" case.
        await this.process(m.id, { model: 'base' });
      } catch {
        // leave the status as-is so the next sweep retries it
      } finally {
        this.inFlight.delete(m.id);
      }
    }
  }

  /**
   * Delete audio that is past its retention window.
   *
   * Deletion itself is deliberately NOT done here. A JS-only sweep would make the "kept for 7
   * days" promise false for exactly the people it matters most to: recording from the Quick
   * Settings tile or the PiP window never starts the JS context, so someone who records for weeks
   * without opening the app would accumulate every minute of unencrypted PCM on disk. Native
   * sweeps on its own schedule too (ProcessingEngine.applyRetention after each transcript), and
   * this call is the app-open catch-up for meetings that were already finished when the window
   * closed on them.
   *
   * The window is resolved here only to skip the JNI hop when the user keeps audio forever;
   * native re-resolves it identically (see resolveRetentionDays) and is the authority.
   */
  private async sweepRetention(): Promise<void> {
    try {
      const days = resolveRetentionDays(
        await db.getSetting('audioRetentionDays'),
        await db.getSetting('keepAudio'),
      );
      if (days < 0) return; // "keep until I delete it" — nothing is ever past its window
      const n = await AudioPipeline.sweepAudioRetention();
      if (n > 0) console.warn(`[pipeline] retention swept audio for ${n} meeting(s)`);
    } catch {
      // Retention is best-effort cleanup. It must never stop a pending meeting being transcribed.
    }
  }

  /**
   * Index meetings recorded before the search index covered titles, minutes and summaries.
   *
   * A batch per sweep rather than a migration at open(): the index is rebuilt row by row from
   * content that already exists, and open() runs on the main thread on a Quick Settings cold
   * start, where a full-library backfill would be a visible freeze before the tile even records.
   * The backlog therefore drains across app opens, oldest first, and search is progressively more
   * complete rather than blocked on being perfect.
   */
  private async backfillSearch(): Promise<void> {
    try {
      const remaining = await db.backfillSearch(25);
      if (remaining > 0) console.warn(`[pipeline] search backfill: ${remaining} meeting(s) to go`);
    } catch {
      // An unindexed meeting is missing from search results, not broken. Never fail a sweep on it.
    }
  }

  // Rule-based minutes — the Free-tier floor. The native ProcessingEngine now runs the equivalent
  // logic itself as part of process()/sweep(), so this is no longer on that happy path. It stays
  // as the on-demand rebuild SpeakersScreen calls after a user merges speakers (see "regenerate"
  // there) — a local, already-'done' meeting with no need to touch the foreground service.
  async buildMinutes(meetingId: string): Promise<void> {
    const utterances = await db.utterances(meetingId);
    if (utterances.length === 0) {
      // No transcript. Whether that is terminal depends on WHY, and getting this wrong is costly
      // in both directions: mark a recoverable meeting terminal and its audio is never
      // transcribed; leave a hopeless one pending and every Library focus re-runs a full VAD
      // pass over it forever, since the resumable-status sweep will keep picking it back up.
      //
      // Two discriminators decide whether this is terminal. No spans at all means the recording
      // genuinely contains no speech; re-running VAD on the same silent audio produces the same
      // nothing, so mark it terminal ('error' renders as "NO SPEECH").
      const spans = await db.segments(meetingId);
      if (spans.length === 0) {
        await db.setStatus(meetingId, 'error');
        return;
      }
      // Spans but no utterances: the STATUS tells us whether ASR actually ran. The native engine
      // sets 'asr' only when the whisper model was present, so status 'asr' means ASR ran and
      // transcribed the spans to nothing (music/noise/unintelligible) — re-running yields the same
      // nothing, so mark it terminal instead of leaving it pending to re-transcribe on every Library
      // sweep forever. A status still at 'vad'/'captured' means ASR has not run (model still
      // downloading), so leave it pending for the next sweep to retry.
      const meeting = await db.getMeeting(meetingId);
      if (meeting?.status === 'asr') await db.setStatus(meetingId, 'error');
      return;
    }
    const speakers = await db.speakers(meetingId);
    const minutes = extractMinutes(utterances, speakers);
    await db.replaceMinutes(meetingId, minutes);
    await this.retitleFromTranscript(meetingId, utterances);
    await db.setStatus(meetingId, 'done');
  }

  /**
   * Rebuild a meeting's rule-based minutes after a speaker merge.
   *
   * This used to detect whether the meeting held LLM minutes and re-run the enhancement, because
   * buildMinutes wiped every row and would otherwise have thrown the prose away. It no longer
   * needs to: replaceMinutes is scoped to a source, so rewriting the rule rows cannot touch the
   * narrative, and narration is a pipeline stage rather than something JS bolts on.
   */
  async regenerateMinutes(meetingId: string): Promise<void> {
    await this.buildMinutes(meetingId);
  }

  /**
   * Replace the timestamp placeholder title with the opening line of the meeting.
   *
   * A Library of rows all reading "Meeting" (or all reading the same date format) is unusable —
   * what people actually remember is how a meeting started. Only overwrites a title the app
   * generated itself: see shouldAutoRetitle, where the meeting's title_edited_at stamp decides,
   * so a rename by the user is never clobbered even when the name they chose reads like a
   * placeholder.
   */
  private async retitleFromTranscript(meetingId: string, utterances: Utterance[]): Promise<void> {
    try {
      // Read straight from the table rather than through db.getMeeting, whose projection does not
      // carry title_edited_at. Losing the guard would be worse than the small ugliness of one raw
      // SELECT here: without the stamp this code cannot tell a rename from a placeholder. (If
      // getMeeting ever selects the column, swap this back — see the handoff note.)
      const rows = JSON.parse(
        await Storage.query(
          'SELECT title, title_edited_at AS titleEditedAt FROM meetings WHERE id = ?',
          JSON.stringify([meetingId]),
        ),
      ) as { title?: string; titleEditedAt?: number | string | null }[];
      const row = rows[0];
      // No row means the meeting was deleted under us, or the read failed. Either way, refusing to
      // write a title is the harmless outcome and overwriting one blindly is not.
      if (!row) return;
      const stamp = Number(row.titleEditedAt ?? 0); // arrives as a JSON number or a string
      if (!shouldAutoRetitle(row.title ?? '', Number.isFinite(stamp) ? stamp : Date.now())) return;

      const opening = utterances
        .map(u => u.text.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (opening.length < 8) return;

      // Cut at a sentence end when there is one close by, otherwise on a word boundary.
      let title = stripOpeningFiller(opening).slice(0, 60);
      const sentenceEnd = title.search(/[.!?]/);
      if (sentenceEnd > 15) title = title.slice(0, sentenceEnd);
      else if (stripOpeningFiller(opening).length > 60) title = title.replace(/\s+\S*$/, '') + '…';

      title = title.charAt(0).toUpperCase() + title.slice(1);
      await db.setTitle(meetingId, title);
    } catch {
      // Titling is cosmetic — never let it fail the pipeline.
    }
  }

  onProgress(cb: ProgressCb): () => void {
    const s = this.emitter.addListener('onStageProgress', cb);
    this.subs.push(s);
    return () => s.remove();
  }

  // Terminal event for a run: outcome is 'done' | 'cancelled' | 'error'. Screens can react to a
  // finished or failed pipeline instead of polling the database until something shows up.
  onComplete(cb: (e: { meetingId: string; outcome: PipelineOutcome; message?: string }) => void): () => void {
    const done = this.emitter.addListener('onStageComplete', cb);
    const err = this.emitter.addListener('onError', cb);
    this.subs.push(done, err);
    return () => {
      done.remove();
      err.remove();
      // Without this, subs grows by two every time awaitNativeComplete registers and unsubscribes
      // a per-meeting listener (once per processed meeting) — a session-lifetime leak.
      this.subs = this.subs.filter(s => s !== done && s !== err);
    };
  }

  // Abort a running pipeline. Takes effect at the next stage boundary — native stages are single
  // long JNI calls and cannot be interrupted mid-inference. Completed stages and the audio are
  // kept, so Reprocess can pick it up again later.
  cancel(meetingId: string): void {
    AudioPipeline.cancel(meetingId);
  }

  dispose() {
    this.subs.forEach(s => s.remove());
    this.subs = [];
  }
}

export const PipelineController = new PipelineControllerImpl();
