import React from 'react';
import renderer, { act } from 'react-test-renderer';
import RecordingBar from '../RecordingBar';
import { useRecordingStore } from '../../state/recordingStore';
import { PipelineController } from '../../pipeline/PipelineController';
import AudioPipeline from '../../native/NativeAudioPipeline';

const nav = { navigate: jest.fn() } as any;

const render = async () => {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<RecordingBar navigation={nav} />);
  });
  return tree;
};

const press = async (tree: renderer.ReactTestRenderer, label: string) => {
  const node = tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
  await act(async () => {
    node.props.onPress();
  });
  await act(async () => {});
};

beforeEach(() => {
  jest.clearAllMocks();
  useRecordingStore.setState({ isRecording: true, sessionId: 'm1', startedAt: Date.now(), paused: false, elapsedMs: 0 });
  (AudioPipeline.stop as jest.Mock).mockResolvedValue(undefined);
  jest.spyOn(PipelineController, 'process').mockResolvedValue(undefined as any);
});

// Found on the Nothing A069: a recording stopped from this bar ended the capture and nothing queued
// it. The Record screen stops and then queues; the bar only stopped, so the meeting sat "captured"
// until some other trigger happened to sweep it - on the Library, where the bar lives, none does.
describe('RecordingBar: stopping from the bar', () => {
  it('queues the meeting for processing, like the Record screen does', async () => {
    const tree = await render();
    await press(tree, 'Stop recording');
    expect(AudioPipeline.stop).toHaveBeenCalledWith('m1');
    expect(PipelineController.process).toHaveBeenCalledWith('m1', { model: 'base' });
  });

  it('queues nothing when no recording was running', async () => {
    useRecordingStore.setState({ isRecording: true, sessionId: null });
    const tree = await render();
    await press(tree, 'Stop recording');
    expect(PipelineController.process).not.toHaveBeenCalled();
  });

  it('does not let a failed enqueue surface as an unhandled rejection', async () => {
    (PipelineController.process as jest.Mock).mockRejectedValue(new Error('refused'));
    const tree = await render();
    await expect(press(tree, 'Stop recording')).resolves.toBeUndefined();
  });
});
