import ModelManager from '../../native/NativeModelManager';
import AudioPipeline from '../../native/NativeAudioPipeline';
import { autoStartProModels, resetProModelsForTest, runProModels, useProModelsStore } from '../proModels';
import { resetDownloadsForTest, useDownloadStore } from '../essentialDownload';

const list = ModelManager.list as jest.Mock;
const download = ModelManager.download as jest.Mock;
const rows = [
  { id: 'whisper-base', kind: 'asr', sizeBytes: 59_707_625, installed: true, needsSubscription: false, unsupportedReason: null },
  { id: 'whisper-small', kind: 'asr', sizeBytes: 190_085_487, installed: false, needsSubscription: true, unsupportedReason: null },
  { id: 'llm-qwen', kind: 'llm', sizeBytes: 1_100_000_000, installed: false, needsSubscription: true, unsupportedReason: null },
  { id: 'embed-bge-small', kind: 'llm', sizeBytes: 36_000_000, installed: false, needsSubscription: true, unsupportedReason: null },
];
const tick = () => new Promise(r => setImmediate(r));
const emit = (downloaded: number, total: number) =>
  (global as any).__TEST_EMIT__('onModelProgress', { id: 'x', downloaded, total });

beforeEach(() => {
  jest.clearAllMocks();
  resetProModelsForTest();
  resetDownloadsForTest();
  list.mockResolvedValue(JSON.stringify(rows));
  download.mockImplementation(async () => {});
});
afterEach(() => list.mockResolvedValue('[]'));

describe("Pro's background download", () => {
  it('fetches every Pro model this phone needs, smallest first, and settles clean', async () => {
    await expect(runProModels()).resolves.toBe(true);
    expect(download.mock.calls.map(c => c[0])).toEqual(['embed-bge-small', 'whisper-small', 'llm-qwen']);
    expect(useProModelsStore.getState()).toMatchObject({ running: false, error: null });
  });

  it('reports the whole run: the models finished plus the one in flight', async () => {
    const release: Array<() => void> = [];
    download.mockImplementation(() => new Promise<void>(r => release.push(r)));
    const done = runProModels();
    await tick();
    expect(useProModelsStore.getState()).toMatchObject({ running: true, total: 1_326_085_487, downloaded: 0 });
    emit(1000, 36_000_000);
    expect(useProModelsStore.getState().downloaded).toBe(1000);
    release[0]();
    await tick();
    expect(useProModelsStore.getState().downloaded).toBe(36_000_000);
    emit(500, 190_085_487);
    expect(useProModelsStore.getState().downloaded).toBe(36_000_500);
    release[1]();
    await tick();
    release[2]();
    await expect(done).resolves.toBe(true);
  });

  it("keeps a failure with native's reason, and a retry clears it the moment it starts", async () => {
    download.mockRejectedValueOnce(new Error('No connection'));
    await expect(runProModels()).resolves.toBe(false);
    expect(useProModelsStore.getState()).toMatchObject({ running: false, error: 'No connection' });
    const retry = runProModels();
    expect(useProModelsStore.getState().error).toBeNull();
    await expect(retry).resolves.toBe(true);
  });

  it("never runs beside first-run setup's download", async () => {
    useDownloadStore.setState({ running: true });
    await expect(runProModels()).resolves.toBe(false);
    expect(download).not.toHaveBeenCalled();
  });

  it('starts by itself only on Pro, and once per launch', async () => {
    expect(autoStartProModels(false)).toBeNull();
    await autoStartProModels(true);
    expect(autoStartProModels(true)).toBeNull();
    expect(download).toHaveBeenCalledTimes(3);
  });

  it('asks for the battery exemption only when there is something to fetch', async () => {
    list.mockResolvedValue(JSON.stringify(rows.map(r => ({ ...r, installed: true }))));
    await runProModels();
    expect(AudioPipeline.requestBatteryExemption).not.toHaveBeenCalled();
  });
});
