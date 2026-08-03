// TurboModule spec for export via the Android share sheet.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // Render a meeting and hand it to the OS share sheet.
  share(meetingId: string, format: 'md' | 'txt' | 'srt'): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('FileExport');
