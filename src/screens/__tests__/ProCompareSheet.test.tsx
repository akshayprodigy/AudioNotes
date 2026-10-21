import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ProCompareSheet from '../ProCompareSheet';
import ModelManager from '../../native/NativeModelManager';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const list = ModelManager.list as unknown as jest.Mock;
afterEach(() => list.mockResolvedValue('[]'));

async function open(onGetPro = jest.fn()) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ProCompareSheet visible allowance={null} onClose={jest.fn()} onGetPro={onGetPro} />);
  });
  return tree;
}
const keys = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll(n => typeof n.props.testID === 'string' && n.props.testID.startsWith('compare-'), { deep: false }).map(n => n.props.testID);

test('promises the larger transcriber where it runs, and the written minutes only where the writer runs', async () => {
  list.mockResolvedValue(JSON.stringify([
    { id: 'whisper-small', kind: 'asr', unsupportedReason: null },
    { id: 'llm-qwen', kind: 'llm', unsupportedReason: 'This phone has 3 GB of memory.' },
  ]));
  const tree = await open();
  expect(keys(tree)).toEqual(['compare-meetings', 'compare-length', 'compare-transcript', 'compare-search', 'compare-export']);
  await act(async () => tree.unmount());
});

test('Get Pro is the way on', async () => {
  const onGetPro = jest.fn();
  const tree = await open(onGetPro);
  await act(async () => tree.root.findAll(n => n.props.label === 'Get Pro' && typeof n.props.onPress === 'function')[0].props.onPress());
  expect(onGetPro).toHaveBeenCalled();
  await act(async () => tree.unmount());
});
