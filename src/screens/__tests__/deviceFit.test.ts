import { DOWNLOAD_HEADROOM_BYTES, runnable, sizeMb, spaceFits, spaceReason, writerBlockedReason } from '../deviceFit';

const REASON =
  'Writing the minutes in plain English needs a phone with 4 GB of memory; this one has 2 GB.';
const writer = { id: 'llm-qwen', kind: 'llm', installed: false, sizeBytes: 1_117_320_736, unsupportedReason: REASON };
const embed = { id: 'embed-bge-small', kind: 'llm', installed: false, sizeBytes: 36_806_944, unsupportedReason: null };
const small = { id: 'whisper-small', kind: 'asr', installed: false, sizeBytes: 190_000_000, unsupportedReason: null };
const okWriter = { ...writer, unsupportedReason: null };

test('the reason is the writer sentence, and only when the writer is blocked', () => {
  expect(writerBlockedReason([writer, embed, small])).toBe(REASON);
  expect(writerBlockedReason([okWriter, embed, small])).toBeNull();
  expect(writerBlockedReason([])).toBeNull();
  // A row without the field (an older native build) is not blocked.
  expect(writerBlockedReason([{ kind: 'llm' }])).toBeNull();
});

test('runnable drops exactly the blocked model and keeps the meaning index', () => {
  expect(runnable([writer, embed, small]).map(m => m.id)).toEqual(['embed-bge-small', 'whisper-small']);
  expect(runnable([okWriter, embed]).map(m => m.id)).toEqual(['llm-qwen', 'embed-bge-small']);
});

test('sizeMb rounds the sum to whole megabytes', () => {
  expect(sizeMb([writer, embed])).toBe(1154);
  expect(sizeMb([])).toBe(0);
});

test('the disk sentence is the one DeviceFit.kt composes, headroom included', () => {
  const need = 1_117_320_736;
  expect(spaceFits(need, need + DOWNLOAD_HEADROOM_BYTES)).toBe(true);
  expect(spaceFits(need, need + DOWNLOAD_HEADROOM_BYTES - 1)).toBe(false);
  expect(spaceReason('the writer', need, 800_000_000)).toBe(
    'Downloading the writer needs 1222 MB free; this phone has 800 MB free. Clear some space and try again.',
  );
});
