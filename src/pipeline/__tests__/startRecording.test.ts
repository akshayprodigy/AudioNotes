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
