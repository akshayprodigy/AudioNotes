# UI: corporate theme, icons, and the live mic visualizer

## Themes & palette

- `src/theme/palette.ts` — a corporate palette with full **light** (default) and **dark** token sets:
  blue primary, green for done/positive, light orange as the warm accent, red reserved for the live
  recording state, on clean white / near-black neutrals.
- `src/theme/ThemeContext.tsx` — `ThemeProvider` + `useTheme()`. Follows the system setting by
  default; a manual **Light / Dark / Auto** toggle in **Settings → Appearance** persists to the
  `settings` table. Navigation bars/headers/status bar all follow the theme.
- Every screen builds its styles from the theme via `makeStyles(colors)` — no hard-coded colors.

## Icons

- `react-native-svg` added; `src/components/Icon.tsx` is a curated stroke-icon set (mic, stop,
  search, settings, record, users, share, download, trash, merge, ai, check, chevron, plus, sun,
  moon, shield, x). All icons are theme-colored, crisp at any size — no icon fonts, no emoji.
- **Run `npm install` again** before rebuilding so `react-native-svg` autolinks.

## Live mic visualizer

- Native: `RecordingService` computes the RMS level of each audio buffer (fast-attack / slow-decay
  smoothing) into `CaptureController.level`; `AudioPipelineModule` emits `onCaptureLevel` to JS ~20×/s
  while recording.
- JS: `src/components/MicVisualizer.tsx` — the record button is a mic whose **pulse rings, icon
  scale, and a 7-bar equalizer all move with your voice** in real time, so it visibly "captures"
  instead of showing a static Stop control. Tapping it still stops. The Record screen also shows a
  running timer and a "LIVE · on-device" pill.

### Verify on device

- Toggle Light / Dark / Auto in Settings — the whole app (including headers) should recolor instantly.
- Start a recording and speak: the rings/equalizer should track your voice level and go still when
  you're quiet; the button turns red while recording.
- Icons should render everywhere (bottom bar, meeting actions, speakers, settings). If any icon is
  blank, confirm `react-native-svg` installed and the app was rebuilt (not just JS-reloaded).
