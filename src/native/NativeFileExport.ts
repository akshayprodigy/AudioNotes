// TurboModule spec for export via the Android share sheet.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

// EVERY FILE EXPORT IS PRO: share, shareWith and exportMp3 reject with code 'PRO_REQUIRED' for a
// Free install — enforced natively (ExportGate.kt), so a screen bug cannot hand a file to a Free
// user. render, copy and preview are not exports and stay free.
export interface Spec extends TurboModule {
  // Render a meeting and hand it to the OS share sheet.
  //
  // 'pdf' is the one people attach to an email: it is the only format that looks the same
  // everywhere, where a .md file arrives as raw asterisks in most mail clients.
  // Uses whatever the person last chose for the attribution line (see src/share/attribution.ts).
  share(meetingId: string, format: 'md' | 'txt' | 'srt' | 'pdf'): Promise<void>;

  // The same document, returned instead of shared — so copy-to-clipboard reuses the ONE renderer
  // rather than growing a second, drifting description of the export format in JS.
  //
  // 'transcript' is render-only: the speaker-attributed record with no minutes above it and no
  // subtitle timings in it, which is what somebody copying from the Script tab means. It is not
  // offered as a share format because a file of it is just the .txt export minus its heading.
  render(meetingId: string, format: 'md' | 'txt' | 'srt' | 'transcript'): Promise<string>;

  // Share with an explicit attribution choice. The share preview calls this, so the file that goes
  // out is the document the preview showed, whatever order the saved setting and the screen were
  // written in. `attribution` is ignored for 'srt', which never carries it.
  shareWith(meetingId: string, format: 'md' | 'txt' | 'srt' | 'pdf', attribution: boolean): Promise<void>;

  // What sharing in this format would send, as text, for the share preview. 'md', 'txt' and 'srt'
  // return the file's own body byte for byte; 'pdf' returns the words of its pages in order. The
  // SAME path as shareWith, so the preview cannot say something the file does not.
  preview(meetingId: string, format: 'md' | 'txt' | 'srt' | 'pdf', attribution: boolean): Promise<string>;

  // The meeting's ORIGINAL recording as a 64 kbps mono MP3, handed to the share sheet. Encoded on the
  // phone by LAME in fixed chunks, so a long meeting never sits in memory. Emits 'onMp3Progress'
  // { fraction: 0..1 }. Rejects with code 'AUDIO_DELETED' (and a sentence to show) when the recording
  // is gone, and 'cancelled' after cancelMp3.
  exportMp3(meetingId: string): Promise<void>;
  cancelMp3(): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;

  // Put text on the clipboard. Native because React Native core dropped its Clipboard module and
  // the project carries no third-party dependency for it.
  copy(text: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('FileExport');
