import React from 'react';
import renderer, { act } from 'react-test-renderer';
import TranscriptTab from '../meeting/TranscriptTab';

const utterances = [
  { id: 'u1', meetingId: 'm', startMs: 0, endMs: 2000, speakerId: 's1', text: 'Hello there.' },
  { id: 'u2', meetingId: 'm', startMs: 2500, endMs: 4000, speakerId: 's1', text: 'Second line.' },
  { id: 'u3', meetingId: 'm', startMs: 5000, endMs: 7000, speakerId: 's2', text: 'And a reply.' },
];
const speakers = [
  { id: 's1', meetingId: 'm', clusterLabel: 'S0', displayName: 'Speaker 1' },
  { id: 's2', meetingId: 'm', clusterLabel: 'S1', displayName: 'Speaker 2' },
];

async function render(extra: Record<string, unknown>) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <TranscriptTab utterances={utterances as never} speakers={speakers as never} positionMs={0} {...extra} />,
    );
  });
  return tree;
}

/** The two ways into "who said this": the line's long press, and the name at the head of a turn. */
describe('speaker gestures', () => {
  it('long-pressing a line hands over the line and its turn', async () => {
    const onLineActions = jest.fn();
    const tree = await render({ onLineActions });
    const line = tree.root.findAllByProps({ accessibilityLabel: 'Second line.' }, { deep: false })[0];
    await act(async () => {
      line.props.onLongPress();
    });
    expect(onLineActions).toHaveBeenCalledTimes(1);
    const [part, turn] = onLineActions.mock.calls[0];
    expect(part.id).toBe('u2');
    expect(turn.parts.map((p: { id: string }) => p.id)).toEqual(['u1', 'u2']);
  });

  it('tapping the name at the head of a turn hands over the turn', async () => {
    const onReassignTurn = jest.fn();
    const tree = await render({ onReassignTurn });
    const head = tree.root.findAllByProps(
      { accessibilityLabel: 'Speaker 2 — change who said this' },
      { deep: false },
    )[0];
    await act(async () => {
      head.props.onPress();
    });
    expect(onReassignTurn.mock.calls[0][0].parts.map((p: { id: string }) => p.id)).toEqual(['u3']);
  });
});
