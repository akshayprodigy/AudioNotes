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
  // service and resolves immediately, so the heavy stages (vad -> asr -> diarize) run AFTER this
  // call returns. We must await the service's terminal event before running the JS layer's
  // deterministic rule-based minutes floor over the transcript — otherwise minutes get built from
  // whatever (possibly empty) transcript happens to exist at the moment `process` resolves.
  async process(
    meetingId: string,
    opts: { model: 'base' | 'small'; useLLM: boolean },
  ): Promise<void> {
    const outcome = await this.awaitNativeComplete(meetingId, () => AudioPipeline.process(meetingId, opts));
    // 'cancelled'/'error' already have their status set natively; nothing to summarize.
    if (outcome !== 'done') return;
    await this.finishMinutes(meetingId, opts.useLLM !== false);
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

  // Shared tail of a successful run: the deterministic rule-based floor, an optional best-effort
  // LLM upgrade, then retention cleanup. Used both when process() just finished natively and when
  // sweep() finds a meeting whose native stages already completed in the background.
  private async finishMinutes(meetingId: string, useLLM: boolean): Promise<void> {
    await this.buildMinutes(meetingId); // deterministic rule-based floor
    if (useLLM) await this.enhanceMinutes(meetingId); // best-effort LLM upgrade
    await this.applyRetention(meetingId);
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
   * Honour the audio-retention setting once a meeting is fully processed.
   *
   * Default is to DELETE the raw audio: it is unencrypted PCM at ~115 MB/hour and, after
   * transcription, its only remaining use is Reprocess. Keeping it is the privacy-weaker and
   * storage-expensive option, so it must be opted into. Only ever runs when a transcript
   * actually exists — otherwise a failed ASR run would destroy the only copy of the meeting.
   */
  async applyRetention(meetingId: string): Promise<void> {
    try {
      const keep = (await db.getSetting('keepAudio')) === '1';
      if (keep) return;
      const utterances = await db.utterances(meetingId);
      if (utterances.length === 0) return; // no transcript — the audio is all we have, keep it
      await AudioPipeline.discardAudio(meetingId);
    } catch {
      // Retention is best-effort; never fail a good transcript over cleanup.
    }
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
        const utt = await db.utterances(m.id);
        const spk = await db.speakers(m.id);
        if (utt.length > 0 && spk.length > 0) {
          // Native stages already done in the background — only the JS minutes remain. Calling
          // full process() here would spin up the foreground service + notification for nothing.
          await this.finishMinutes(m.id, true);
        } else {
          // Still owes native work — enqueue into the service, which resumes only the missing
          // stages (ResumePlan).
          await this.process(m.id, { model: 'base', useLLM: true });
        }
      } catch {
        // leave the status as-is so the next sweep retries it
      } finally {
        this.inFlight.delete(m.id);
      }
    }
  }

  // Rule-based minutes — the Free-tier floor. Runs whenever a transcript exists.
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
