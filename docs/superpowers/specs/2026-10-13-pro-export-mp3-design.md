# Pro-only export and MP3 export — design

*13 October 2026. Founder decisions made in conversation the same day; this document is their record.*

## Decisions

1. **All exports are Pro:** MP3, SRT, PDF, Markdown, plain text. This reverses the earlier "free export" rule (October plan §1, §244; `FOUNDER_TODO_2026-10.md` A-section) on purpose, to match the Play Console Benefits line ("Export meetings (MP3, SRT, PDF)").
2. **Copy stays free** (`FileExport.copy` / `render` for the clipboard). Only files that leave the app through the share sheet are gated.
3. **MP3 = the original recording only.** One file, whole meeting. No per-speaker audio, no clips.
4. **Free-user flow:** Export opens the Share screen as today, with the preview and the format list. Tapping Share opens the Pro sheet instead of the share dialog.
5. **Encoder:** LAME, compiled into the app and run on the phone. Audio never leaves the device. No server, no AAC substitute.
6. **Out of scope:** database or audio encryption (a separate later project, SQLCipher is the candidate; Base64 was considered and rejected — reversible, +33 % size, breaks search and streaming), any change to the Free allowance, any change to Copy.

## 1. Pro gate

- The gate lives in the native export path (`FileExportModule`: `share`, `shareWith`, and the new MP3 call), not only in the screen, so a screen bug cannot hand a file to a Free user.
- Pro status comes from the same licence check the rest of the app uses (`LicenceStore.current`). Meetings made before this change are gated the same way.
- Refusal is a typed rejection (`PRO_REQUIRED`) that the Share screen turns into the Pro sheet. `render` and `copy` are not gated.
- `preview` stays ungated: seeing what you would get is the point of decision 4.

## 2. MP3 export

- New format `mp3` in the Share screen's list, labelled "MP3 (original recording)".
- A native encoder reads the meeting's `audio.pcm` (16 kHz, mono, PCM16, headerless; see `PlayerModule.kt`) and writes `<title>.mp3` to the cache directory at 64 kbps mono, then hands it to the share sheet. Roughly 28 MB per hour.
- Encoding runs in fixed-size chunks (no whole-file buffer), reports progress, and can be cancelled. A 3-hour meeting must not exhaust memory.
- ID3 tags: title and date.
- The cache file is removed after sharing; stale files are swept at app start.
- **Audio deleted:** meetings with `audio_retained = 0` or a missing file show "The recording for this meeting was deleted, so there is nothing to export." and the MP3 option is disabled. It never fails silently.
- Imported meetings export their decoded audio, which is what `audio.pcm` holds.

## 3. LAME and licence

- LAME is LGPL. It is built as a separate shared library so it can be replaced, which is the normal way to meet the licence.
- A new **Settings → Open-source notices** screen names LAME with the licence text and a link. If the app already has third-party notices anywhere, they are folded into the same screen.

## 4. Wording that changes

- Pro sheet's included list: add "Export: MP3, PDF, SRT, Markdown, text".
- `docs/play-console.md`, the landing page (`server/app/landing.py`) and the Free-tier copy: remove "free export", state that export is Pro.
- The Share screen and the Export menu hint in `MeetingScreen.tsx` (`'Share the minutes as a PDF, Markdown, plain text or subtitles.'`) gain the MP3 and the Pro note.
- The Play Console Benefits line is already accurate.

## 5. Tests (house rule: every rule has a mutant)

- Gate logic, JVM: Free refused, Pro allowed, for every format; `render`/`copy` allowed for Free. Mutants: gate removed, gate inverted, one format skipped.
- Audio-deleted path: refused with the explanatory message, never a crash. Mutant: check removed.
- Encoder, device test: encode a known tone, decode it, check duration and dominant frequency; a long synthetic input stays within a memory bound.
- JS: Share screen shows the Pro sheet on a `PRO_REQUIRED` rejection; MP3 row disabled when audio is gone.
- Device check on the Galaxy A07: Free is refused → Pro exports → the MP3 opens in a player. Never open the A07's real meetings.
- Full `scripts/gate.sh` before any build.

## Risks

- LGPL obligations are real, if small: the notices screen and the replaceable library are required, not optional.
- Reversing "free export" costs existing free users something they had. Founder's call, made 13 Oct.
- The Free allowance text on the site already says "5 meetings a month, up to 1 hour"; none of it mentions export, so only the explicit "free export" lines change.
