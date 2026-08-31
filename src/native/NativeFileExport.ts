// TurboModule spec for export via the Android share sheet.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // Render a meeting and hand it to the OS share sheet.
  //
  // 'pdf' is the one people attach to an email: it is the only format that looks the same
  // everywhere, where a .md file arrives as raw asterisks in most mail clients.
  share(meetingId: string, format: 'md' | 'txt' | 'srt' | 'pdf'): Promise<void>;

  // The same document, returned instead of shared — so copy-to-clipboard reuses the ONE renderer
  // rather than growing a second, drifting description of the export format in JS.
  //
  // 'transcript' is render-only: the speaker-attributed record with no minutes above it and no
  // subtitle timings in it, which is what somebody copying from the Script tab means. It is not
  // offered as a share format because a file of it is just the .txt export minus its heading.
  render(meetingId: string, format: 'md' | 'txt' | 'srt' | 'transcript'): Promise<string>;

  // Put text on the clipboard. Native because React Native core dropped its Clipboard module and
  // the project carries no third-party dependency for it.
  copy(text: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('FileExport');
