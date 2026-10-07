import { act } from 'react-test-renderer';
import ModelManager from '../../native/NativeModelManager';
import { resetDownloadsForTest, runDownloads, useDownloadStore } from '../essentialDownload';

const download = ModelManager.download as jest.Mock;
const Q = [
  { id: 'vad', purpose: 'Voice detection', required: true },
  { id: 'asr', purpose: 'Speech to text', required: true },
  { id: 'llm', purpose: 'The writer', required: false },
];

beforeEach(() => {
  jest.clearAllMocks();
  download.mockImplementation(async () => {});
  resetDownloadsForTest();
});

describe('the shared download run', () => {
  it('fetches the queue in order, is running while it does, and settles clean', async () => {
    let release!: () => void;
    download.mockImplementationOnce(() => new Promise<void>(r => (release = r)));
    const done = runDownloads(Q);
    expect(useDownloadStore.getState()).toMatchObject({ running: true, failed: false, current: 'Voice detection', of: 3 });
    release();
    await expect(done).resolves.toBe(true);
    expect(download.mock.calls.map(c => c[0])).toEqual(['vad', 'asr', 'llm']);
    expect(useDownloadStore.getState()).toMatchObject({ running: false, failed: false });
  });

  it('a second request while one is going joins it instead of starting another', async () => {
    let release!: () => void;
    download.mockImplementationOnce(() => new Promise<void>(r => (release = r)));
    const a = runDownloads(Q);
    const b = runDownloads(Q);
    release();
    await Promise.all([a, b]);
    expect(download).toHaveBeenCalledTimes(3);
  });

  it('stops on a failed REQUIRED model, remembers which, and a retry carries on and clears the failure', async () => {
    download.mockRejectedValueOnce(new Error('offline')); // vad fails
    await expect(runDownloads(Q)).resolves.toBe(false);
    expect(useDownloadStore.getState()).toMatchObject({ running: false, failed: true, failedPurpose: 'Voice detection' });
    expect(download).toHaveBeenCalledTimes(1); // nothing after the failure was attempted

    download.mockClear();
    const retry = runDownloads(Q);
    expect(useDownloadStore.getState().failed).toBe(false); // honest the moment it is trying again
    await expect(retry).resolves.toBe(true);
    expect(download).toHaveBeenCalledTimes(3);
  });

  it('does not fail the run over an optional model', async () => {
    download.mockImplementation(async (id: string) => {
      if (id === 'llm') throw new Error('too big');
    });
    await expect(runDownloads(Q)).resolves.toBe(true);
    expect(useDownloadStore.getState().failed).toBe(false);
  });

  it('carries the live byte count of the model in flight, from native progress events', async () => {
    let release!: () => void;
    download.mockImplementationOnce(() => new Promise<void>(r => (release = r)));
    const done = runDownloads(Q);
    await act(async () => {
      (global as any).__TEST_EMIT__('onModelProgress', { id: 'vad', downloaded: 500_000, total: 2_000_000 });
    });
    expect(useDownloadStore.getState().live).toEqual({ id: 'vad', downloaded: 500_000, total: 2_000_000 });
    release();
    await done;
    expect(useDownloadStore.getState().live).toBeNull();
  });
});
