import ModelManager from '../../native/NativeModelManager';
import { resetActiveDownloadsForTest, shownDownloads, STALE_MS, useActiveDownloads, watchDownloads } from '../activeDownloads';

const list = ModelManager.list as jest.Mock;
const emit = (id: string, downloaded: number, total: number) =>
  (global as any).__TEST_EMIT__('onModelProgress', { id, downloaded, total });
const tick = () => new Promise(r => setImmediate(r));

beforeEach(async () => {
  resetActiveDownloadsForTest();
  list.mockResolvedValue(JSON.stringify([
    { id: 'llm-qwen', purpose: 'Writes the minutes in plain English', required: false },
    { id: 'whisper-base', purpose: 'Writes down what was said', required: true },
  ]));
  watchDownloads(() => 1000);
  await tick();
});
afterEach(() => list.mockResolvedValue('[]'));

describe('active downloads', () => {
  it('holds a download in flight under what it is for', () => {
    emit('llm-qwen', 100, 1000);
    expect(useActiveDownloads.getState().live['llm-qwen']).toMatchObject({
      purpose: 'Writes the minutes in plain English', downloaded: 100, total: 1000, at: 1000,
    });
  });

  it('forgets it the moment it finishes', () => {
    emit('llm-qwen', 100, 1000);
    emit('llm-qwen', 1000, 1000);
    expect(useActiveDownloads.getState().live['llm-qwen']).toBeUndefined();
  });

  it('shows only what the setup card does not, and nothing that has gone quiet', () => {
    emit('llm-qwen', 100, 1000);
    emit('whisper-base', 5, 50);
    const live = useActiveDownloads.getState().live;
    expect(shownDownloads(live, 1000).map(d => d.id)).toEqual(['llm-qwen']);
    expect(shownDownloads(live, 1000 + STALE_MS)).toEqual([]);
  });
});
