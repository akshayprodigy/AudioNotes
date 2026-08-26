# Graph Report - /Users/akshayghosh/ReactNative/InnoCoreLabs/AudioNotes/src  (2026-08-12)

## Corpus Check
- Corpus is ~25,922 words - fits in a single context window. You may not need a graph.

## Summary
- 279 nodes · 735 edges · 14 communities (8 shown, 6 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 24 edges (avg confidence: 0.76)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Icon & Waveform UI|Icon & Waveform UI]]
- [[_COMMUNITY_Database & Storage|Database & Storage]]
- [[_COMMUNITY_UI Primitives|UI Primitives]]
- [[_COMMUNITY_Native Audio Pipeline|Native Audio Pipeline]]
- [[_COMMUNITY_PiP Recorder UI|PiP Recorder UI]]
- [[_COMMUNITY_Theme & Palette|Theme & Palette]]
- [[_COMMUNITY_Pipeline Controller|Pipeline Controller]]
- [[_COMMUNITY_LLM Minutes Enhancement|LLM Minutes Enhancement]]
- [[_COMMUNITY_Model Manager|Model Manager]]
- [[_COMMUNITY_PiP Mode Hook|PiP Mode Hook]]
- [[_COMMUNITY_Responsive Scale Tokens|Responsive Scale Tokens]]
- [[_COMMUNITY_Pipeline Cancel|Pipeline Cancel]]
- [[_COMMUNITY_Search Screen|Search Screen]]
- [[_COMMUNITY_Tilt Helper|Tilt Helper]]

## God Nodes (most connected - your core abstractions)
1. `s()` - 43 edges
2. `useTheme()` - 40 edges
3. `db query layer` - 21 edges
4. `Icon component` - 19 edges
5. `PipelineControllerImpl` - 18 edges
6. `sv()` - 18 edges
7. `Txt` - 15 edges
8. `AudioPipeline TurboModule` - 15 edges
9. `Raised (hard-shadow container)` - 14 edges
10. `Meeting` - 13 edges

## Surprising Connections (you probably didn't know these)
- `PipRecorder` --references--> `AudioPipeline TurboModule`  [INFERRED]
  components/PipRecorder.tsx → native/NativeAudioPipeline.ts
- `usePipMode hook` --conceptually_related_to--> `Pip TurboModule`  [INFERRED]
  hooks/usePipMode.ts → native/NativePip.ts
- `PipelineController.process` --conceptually_related_to--> `MeetingStatus`  [INFERRED]
  src/pipeline/PipelineController.ts → pipeline/types.ts
- `MeetingScreen` --conceptually_related_to--> `PipelineStage`  [INFERRED]
  src/screens/MeetingScreen.tsx → pipeline/types.ts
- `OnboardingScreen` --conceptually_related_to--> `Meeting`  [INFERRED]
  src/screens/OnboardingScreen.tsx → pipeline/types.ts

## Import Cycles
- 3-file cycle: `components/RecordingBar.tsx -> navigation/RootNavigator.tsx -> screens/LibraryScreen.tsx -> components/RecordingBar.tsx`

## Hyperedges (group relationships)
- **Native TurboModule JS-native seam** — native_nativeaudiopipeline_spec, native_nativefileexport_spec, native_nativellm_spec, native_nativemodelmanager_spec, native_nativepip_spec, native_nativestorage_spec [INFERRED 0.80]
- **Typed encrypted-DB access layer** — db_queries_db, db_queries_run, native_nativestorage_spec, db_schema_schema [INFERRED 0.80]
- **onCaptureLevel-driven wave meter** — components_livewaveform_livewaveform, components_piprecorder_micwave, native_nativeaudiopipeline_spec [INFERRED 0.75]
- **Minutes generation tiers: rule floor + LLM enhance** — src_pipeline_minutes_extractminutes, src_pipeline_summarize_enhanceminutes, src_pipeline_pipelinecontroller_process [INFERRED 0.85]
- **VAD -> ASR -> diarize -> minutes staged pipeline reflected into MeetingStatus** — src_pipeline_types_meetingstatus, src_pipeline_types_pipelinestage, src_pipeline_pipelinecontroller_process [INFERRED 0.80]
- **Library store -> screen data flow over the Meeting shape** — src_state_librarystore_uselibrarystore, src_screens_libraryscreen_libraryscreen, src_pipeline_types_meeting [INFERRED 0.80]

## Communities (14 total, 6 thin omitted)

### Community 0 - "Icon & Waveform UI"
Cohesion: 0.09
Nodes (53): Icon component, IconName type, Props, render(), HEIGHTS, LiveWaveform meter, Props, SHADE (+45 more)

### Community 1 - "Database & Storage"
Cohesion: 0.06
Nodes (52): db query layer, run (SQL helper), MIGRATIONS, SCHEMA (SQLCipher DDL), Storage TurboModule, detectOwner(), DraftMinute, extractMinutes() (+44 more)

### Community 2 - "UI Primitives"
Cohesion: 0.09
Nodes (15): confirmDestructive, quoted, Badge, LiveDot(), ProgressRing, SectionRule(), SheetAction, Slide() (+7 more)

### Community 3 - "Native Audio Pipeline"
Cohesion: 0.10
Nodes (7): Mascot (Pip), Mood type, Props, AudioPipeline TurboModule, navigationRef, RootNavigator, Stack

### Community 4 - "PiP Recorder UI"
Cohesion: 0.16
Nodes (17): fmt(), MicWave (PiP wave), PipRecorder, styles, fmt(), Nav, RecordingBar, styles (+9 more)

### Community 5 - "Theme & Palette"
Cohesion: 0.17
Nodes (17): Colors interface, Colors, darkColors, font, lightColors, motion, screen, spacing (+9 more)

### Community 7 - "LLM Minutes Enhancement"
Cohesion: 0.17
Nodes (9): Llm TurboModule, chunkTranscript(), enhanceMinutes(), GenerateFn, isPlaceholder(), mapPrompt(), parseMinutesJson(), reducePrompt() (+1 more)

### Community 10 - "Responsive Scale Tokens"
Cohesion: 0.67
Nodes (3): s (responsive scale), text (type token resolver), type (type scale)

## Knowledge Gaps
- **54 isolated node(s):** `Props`, `Props`, `HEIGHTS`, `SHADE`, `Mood type` (+49 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `db query layer` connect `Database & Storage` to `Icon & Waveform UI`, `UI Primitives`, `Native Audio Pipeline`?**
  _High betweenness centrality (0.104) - this node is a cross-community bridge._
- **Why does `PipelineControllerImpl` connect `Pipeline Controller` to `Database & Storage`?**
  _High betweenness centrality (0.094) - this node is a cross-community bridge._
- **Why does `AudioPipeline TurboModule` connect `Native Audio Pipeline` to `PiP Recorder UI`?**
  _High betweenness centrality (0.081) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `db query layer` (e.g. with `SCHEMA (SQLCipher DDL)` and `PipelineController.deleteMeeting`) actually correct?**
  _`db query layer` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Props`, `Props`, `HEIGHTS` to the rest of the system?**
  _54 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Icon & Waveform UI` be split into smaller, more focused modules?**
  _Cohesion score 0.08867427568042142 - nodes in this community are weakly interconnected._
- **Should `Database & Storage` be split into smaller, more focused modules?**
  _Cohesion score 0.06101190476190476 - nodes in this community are weakly interconnected._