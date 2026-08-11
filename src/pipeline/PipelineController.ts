// JS-side orchestrator. It does NOT do any heavy work — it starts/stops capture,
// kicks off native processing, listens to native progress events, and reflects them
// into app state. All ASR/diarization/LLM work happens off-thread in native/C++.
import { NativeEventEmitter, NativeModules } from 'react-native';
import AudioPipeline from '../native/NativeAudioPipeline';
import Llm from '../native/NativeLlm';
import { db } from '../db/queries';
import { extractMinutes } from './minutes';
import { enhanceMinutes } from './summarize';
import type { PipelineOutcome, StageProgress, Utterance } from './types';

type ProgressCb = (p: StageProgress) => void;

class PipelineControllerImpl {
  private emitter = new NativeEventEmitter(NativeModules.AudioPipeline);
  private subs: { remove(): void }[] = [];

  async startRecording(language: string | null): Promise<string> {
    return AudioPipeline.start({ sampleRate: 16000, language });
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
  // service and resolves immediately, so the heavy stages (vad -> asr -> diarize -> minutes) run
  // AFTER this call returns. We await the service's terminal event so callers can rely on
  // process() resolving only once the meeting is fully finished — the native ProcessingEngine now
  // builds the rule-based minutes, retitles, applies audio retention, and sets the terminal status
  // itself. JS only adds the best-effort LLM upgrade on top when the app is open and the device is
  // capable — enhanceMinutes() no-ops when there are no utterances or no LLM model.
  async process(
    meetingId: string,
    opts: { model: 'base' | 'small'; useLLM: boolean },
  ): Promise<void> {
    const outcome = await this.awaitNativeComplete(meetingId, () => AudioPipeline.process(meetingId, opts));
    // 'cancelled'/'error' already have their status set natively; nothing to enhance.
    if (outcome !== 'done') return;
    if (opts.useLLM !== false) await this.enhanceMinutes(meetingId);
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
   * Process any meeting that still owes work — captured via the floating bubble, or abandoned
   * part-way by a process kill. Called on app open and on Library focus.
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
    const pending = await db.pendingMeetings();
    for (const m of pending) {
      if (this.inFlight.has(m.id)) continue;
      this.inFlight.add(m.id);
      try {
        // Always route through process() -> the native service. Its status-aware completion gate
        // resumes only the missing stages (ResumePlan) — a meeting whose rows already exist but
        // whose status isn't 'done' has just its minutes step re-run natively, so this no longer
        // needs a JS-side shortcut for the "utterances + speakers already present" case.
        await this.process(m.id, { model: 'base', useLLM: true });
      } catch {
        // leave the status as-is so the next sweep retries it
      } finally {
        this.inFlight.delete(m.id);
      }
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
   * Rebuild a meeting's minutes after a speaker merge WITHOUT downgrading its tier.
   *
   * SpeakersScreen's "Regenerate" used to call buildMinutes directly, which always rewrites the
   * rule-based floor (source:'rule') — silently discarding any LLM-enhanced minutes the meeting
   * had. Here we detect whether the meeting currently holds LLM minutes and, if so, re-run the LLM
   * enhancement after the rule rebuild so the meeting keeps its enhanced tier. enhanceMinutes is
   * already gated on the model being available/capable and falls back to keeping the rule minutes
   * on any failure, so an LLM-less device degrades gracefully to the rebuilt rule floor.
   */
  async regenerateMinutes(meetingId: string): Promise<void> {
    const existing = await db.minutes(meetingId);
    const wasLlm = existing.some(m => m.source === 'llm');
    await this.buildMinutes(meetingId);
    if (wasLlm) await this.enhanceMinutes(meetingId);
  }

  /**
   * Replace the timestamp placeholder title with the opening line of the meeting.
   *
   * A Library of rows all reading "Meeting" (or all reading the same date format) is unusable —
   * what people actually remember is how a meeting started. Only overwrites a title the app
   * generated itself, so a rename by the user is never clobbered.
   */
  private async retitleFromTranscript(meetingId: string, utterances: Utterance[]): Promise<void> {
    try {
      const meeting = await db.getMeeting(meetingId);
      const current = meeting?.title ?? '';
      const isGenerated = current === 'Meeting' || / meeting · /.test(current);
      if (!isGenerated) return;

      const opening = utterances
        .map(u => u.text.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (opening.length < 8) return;

      // Cut at a sentence end when there is one close by, otherwise on a word boundary.
      let title = opening.slice(0, 60);
      const sentenceEnd = title.search(/[.!?]/);
      if (sentenceEnd > 15) title = title.slice(0, sentenceEnd);
      else if (opening.length > 60) title = title.replace(/\s+\S*$/, '') + '…';

      title = title.charAt(0).toUpperCase() + title.slice(1);
      await db.setTitle(meetingId, title);
    } catch {
      // Titling is cosmetic — never let it fail the pipeline.
    }
  }

  // LLM enhancement (Pro) — replaces the minutes with a nicer LLM version IF a capable device has
  // the Qwen model installed and generation+parsing succeed. On any failure the rule-based minutes
  // written by buildMinutes() stay in place. Never throws to the caller.
  async enhanceMinutes(meetingId: string): Promise<void> {
    try {
      const utterances = await db.utterances(meetingId);
      if (utterances.length === 0) return;
      if (!(await Llm.available()) || !(await Llm.capable())) return;
      if (!(await Llm.load())) return;
      try {
        const speakers = await db.speakers(meetingId);
        const mins = await enhanceMinutes(utterances, speakers, (p, mt) => Llm.generate(p, mt));
        if (mins && mins.length > 0) {
          await db.replaceMinutes(meetingId, mins);
          await db.setStatus(meetingId, 'done');
        }
      } finally {
        await Llm.unload();
      }
    } catch {
      // keep the rule-based minutes; enhancement is best-effort
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
