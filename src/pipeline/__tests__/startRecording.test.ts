import AudioPipeline from '../../native/NativeAudioPipeline';
import { PipelineController } from '../PipelineController';

/** Phase 5: dictation reaches native as `mode`; a meeting sends no such key at all. */
test('startRecording passes the mode through, and only when there is one', async () => {
  (AudioPipeline.start as jest.Mock).mockClear();
  await PipelineController.startRecording(null, 'dictation');
  expect((AudioPipeline.start as jest.Mock).mock.calls[0][0]).toMatchObject({
    sampleRate: 16000, language: null, mode: 'dictation',
  });
  await PipelineController.startRecording('en');
  expect((AudioPipeline.start as jest.Mock).mock.calls[1][0]).not.toHaveProperty('mode');
  expect((AudioPipeline.start as jest.Mock).mock.calls[1][0]).toMatchObject({ language: 'en' });
});

/**
 * The cap and the allowance are native now (CaptureController.start). JS used to send `capMs`,
 * which the Quick Settings tile never did: a limit the caller supplies is a limit the tile skips.
 */
test('startRecording sends no cap of its own', async () => {
  const start = AudioPipeline.start as jest.Mock;
  start.mockClear();
  await PipelineController.startRecording('en');
  await PipelineController.startRecording(null, 'dictation');
  for (const call of start.mock.calls) expect(call[0]).not.toHaveProperty('capMs');
});

test('a refusal for a spent allowance keeps its code and its reset date for the screen', async () => {
  const refusal = Object.assign(new Error('2026-11-01'), { code: 'allowance_exhausted' });
  (AudioPipeline.start as jest.Mock).mockRejectedValueOnce(refusal);
  await expect(PipelineController.startRecording('en')).rejects.toMatchObject({
    code: 'allowance_exhausted',
    message: '2026-11-01',
  });
});
