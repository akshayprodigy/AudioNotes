// JS-side orchestrator. It does NOT do any heavy work — it starts/stops capture,
// kicks off native processing, listens to native progress events, and reflects them
// into app state. All ASR/diarization/LLM work happens off-thread in native/C++.
import { NativeEventEmitter, NativeModules } from 'react-native';
import AudioPipeline from '../native/NativeAudioPipeline';
import Llm from '../native/NativeLlm';
import { db } from '../db/queries';
import { extractMinutes } from './minutes';
import { enhanceMinutes } from './summarize';
import type { StageProgress } from './types';

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

  // Native runs the heavy stages (vad -> asr), persisting each. Then the JS layer runs the
  // deterministic rule-based minutes floor over the transcript (small text work; shared iOS+Android).
  async process(
    meetingId: string,
    opts: { model: 'base' | 'small'; useLLM: boolean },
  ): Promise<void> {
    await AudioPipeline.process(meetingId, opts);
    await this.buildMinutes(meetingId); // deterministic floor first — always present
    if (opts.useLLM !== false) await this.enhanceMinutes(meetingId); // best-effort upgrade
  }

  // Process any meetings captured while the app wasn't in front (e.g. the floating bubble).
  // Called on app open / Library focus so overlay-recorded meetings get transcribed + summarized.
  async processPending(): Promise<void> {
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
      try {
        await this.process(m.id, { model: 'base', useLLM: true });
      } catch {
        // leave it 'captured' to retry next time
      }
    }
  }

  // Rule-based minutes — the Free-tier floor. Runs whenever a transcript exists.
  async buildMinutes(meetingId: string): Promise<void> {
    const utterances = await db.utterances(meetingId);
    if (utterances.length === 0) return; // ASR skipped (no whisper model yet)
    const speakers = await db.speakers(meetingId);
    const minutes = extractMinutes(utterances, speakers);
    await db.replaceMinutes(meetingId, minutes);
    await db.setStatus(meetingId, 'done');
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

  dispose() {
    this.subs.forEach(s => s.remove());
    this.subs = [];
  }
}

export const PipelineController = new PipelineControllerImpl();
