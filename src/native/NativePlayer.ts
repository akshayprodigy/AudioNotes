// TurboModule spec for meeting playback.
//
// Playback is native for a structural reason, not a performance one: recordings are stored as a
// HEADERLESS 16 kHz mono PCM16 stream (`audio.pcm`, written by RecordingService), which no media
// player will open — there is no container to parse. An AudioTrack fed from a file offset handles
// it directly, and seeking becomes arithmetic rather than a container index:
//
//     byteOffset = ms * 16000 * 2 / 1000 = ms * 32
//
// That exactness is what makes tap-a-transcript-turn-to-play work. Utterance timestamps are
// already anchored to the original recording's timeline (whisper_asr.cpp re-anchors each chunk's
// segment times with `chunk.first + t0`), so a turn's startMs seeks to the moment it was said with
// no mapping table in between.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // Whether this meeting still has playable audio on disk. Decided by looking at the file, NOT by
  // the `audio_retained` flag: that column is only ever written to 0, and after a restore it
  // arrives from the donor phone describing a path that was never on this device.
  hasAudio(meetingId: string): Promise<boolean>;

  // Load a meeting for playback and report its length. Rejects when the audio is gone, and
  // deliberately rejects while a recording is in progress: capture uses an UNPROCESSED audio
  // source with no echo cancellation, so playing one meeting through the speaker while another
  // records writes the playback into the new recording and transcribes it.
  open(meetingId: string): Promise<{ durationMs: number }>;

  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  // Release the audio device. Playback holds audio focus, so this must run when the screen goes.
  stop(): Promise<void>;

  // 'onPlayerTick' { positionMs, durationMs, playing }, 'onPlayerEnd' {}.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Player');
