import React from 'react';
import { Alert } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import SampleBanner from '../SampleBanner';
import { SAMPLE_ID } from '../sampleId';
import { deleteSample } from '../seedSample';

jest.mock('../seedSample', () => ({
  seedSample: jest.fn(async () => ({ created: true })),
  deleteSample: jest.fn(async () => {}),
}));

const texts = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => String(n.type) === 'Text').map(n => [n.props.children].flat().join(''));

describe('SampleBanner', () => {
  const make = async (onDeleted: () => void) => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SampleBanner meetingId={SAMPLE_ID} onDeleted={onDeleted} />);
    });
    return tree;
  };

  it('is one short line with Delete sample on the same row', async () => {
    const tree = await make(() => {});
    expect(texts(tree)).toContain('Sample meeting — not from your microphone.');
    const banner = tree.root.findByProps({ accessibilityRole: 'summary' });
    expect(banner.props.style).toEqual(expect.objectContaining({ flexDirection: 'row' }));
  });

  it('Delete sample asks, then calls the handler', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const onDeleted = jest.fn();
    const tree = await make(onDeleted);
    await act(async () => tree.root.findByProps({ accessibilityLabel: 'Delete sample' }).props.onPress());
    const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    await act(async () => buttons.find(b => b.text === 'Delete sample')!.onPress!());
    expect(deleteSample).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });
});
