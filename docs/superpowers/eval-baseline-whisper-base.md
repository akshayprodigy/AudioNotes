# Eval run

- run id: `20260824-193132`
- cli: `cpp/cli/build/audionotes_cli`

## Summary

| fixture | source | audio | WER | S | D | I | ref words |
|---|---|---:|---:|---:|---:|---:|---:|
| ES2002a | ami | 1273s | 30.8% | 329 | 304 | 159 | 2572 |

**Overall WER: 30.8%** (792 errors over 2572 reference words)

## Corpus caveats

- AMI Meeting Corpus (CC BY 4.0). 2000s meeting-room audio, headset/far-field mics, mostly British/European accents, scenario-driven, no code-switching. A proxy for detecting regressions, NOT evidence the product works for in-person phone capture.
