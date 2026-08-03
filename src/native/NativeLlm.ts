// TurboModule spec for the on-device LLM (llama.cpp / Qwen). Used to enhance minutes.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  available(): Promise<boolean>; // model downloaded
  capable(): Promise<boolean>; // device has enough RAM
  load(): Promise<boolean>; // load the installed Qwen model (once)
  generate(prompt: string, maxTokens: number): Promise<string>;
  unload(): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Llm');
