// TurboModule spec for the on-device LLM (llama.cpp / Qwen). Used to enhance minutes.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  available(): Promise<boolean>; // model downloaded
  capable(): Promise<boolean>; // device has enough RAM
  load(): Promise<boolean>; // load the installed Qwen model (once)
  generate(prompt: string, maxTokens: number): Promise<string>;
  unload(): Promise<void>;
  // Ask this meeting (sub-project 5): JSON `{refusal, id, answer, cites, nothing}`. `refusal` is
  // NOT_PRO | NO_MODEL | NOT_CAPABLE | BUSY or null; `cites` is [{n, refId, startMs, speaker}].
  // Loads the writer if it is not resident and keeps it; call unload() when the screen leaves.
  ask(meetingId: string, question: string): Promise<string>;
  // The meeting's past asks, oldest first: JSON [{id, question, answer, cites, askedAt}].
  asks(meetingId: string): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Llm');
