import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { useRecordingStore } from '../src/state/recordingStore';
import RecordingBar from '../src/components/RecordingBar';

// No theme mock: `useTheme()` returns the real light palette without a provider, and mocking
// `../src/theme` would strip the `text`/`s`/`radius` helpers that `Txt` (from ./ui) relies on.
const nav = { navigate: jest.fn() } as any;

test('hidden when not recording, shown when recording', () => {
  let tree!: renderer.ReactTestRenderer;

  act(() => {
    useRecordingStore.setState({ isRecording: false });
  });
  act(() => {
    tree = renderer.create(<RecordingBar navigation={nav} />);
  });
  expect(tree.toJSON()).toBeNull();
  act(() => tree.unmount());

  act(() => {
    useRecordingStore.setState({ isRecording: true, startedAt: Date.now(), elapsedMs: 5000 });
  });
  act(() => {
    tree = renderer.create(<RecordingBar navigation={nav} />);
  });
  expect(tree.toJSON()).not.toBeNull();
  act(() => tree.unmount());

  act(() => {
    useRecordingStore.setState({ isRecording: false, startedAt: null });
  });
});
