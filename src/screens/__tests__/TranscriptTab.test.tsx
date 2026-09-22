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

/**
 * A dictation is one voice by definition (Phase 5): diarization is skipped and no utterance has
 * a speaker. The tab must not then dress every turn as "Unlabelled" and offer to change who said
 * it — there is nobody else it could have been. Seen on the Galaxy A07, 22 Sep.
 */
describe('one voice', () => {
  const dictated = [
    { id: 'd1', meetingId: 'm', startMs: 8000, endMs: 10000, speakerId: null, text: 'Note for Priya.' },
    { id: 'd2', meetingId: 'm', startMs: 10500, endMs: 12000, speakerId: null, text: 'We will not ship.' },
  ];

  it('a meeting without speakers still says Unlabelled and offers the name', async () => {
    const tree = await render({ utterances: dictated, speakers: [], onReassignTurn: jest.fn() });
    const heads = tree.root.findAllByProps(
      { accessibilityLabel: 'Unlabelled — change who said this' },
      { deep: false },
    );
    expect(heads.length).toBe(1);
  });

  it('a dictation shows no speaker head and does not offer to change who said it', async () => {
    const tree = await render({
      utterances: dictated,
      speakers: [],
      oneVoice: true,
      onReassignTurn: jest.fn(),
      onPlayTurn: jest.fn(),
      onLineActions: jest.fn(),
    });
    const heads = tree.root.findAllByProps(
      { accessibilityLabel: 'Unlabelled — change who said this' },
      { deep: false },
    );
    expect(heads.length).toBe(0);
    const texts = tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);
    expect(texts.some(t => t.includes('Unlabelled'))).toBe(false);
    // The lines and the stamp survive: the timestamp is how a line is played from.
    expect(texts).toEqual(expect.arrayContaining(['Note for Priya.', 'We will not ship.', '00:08']));
    // The hint stops promising a speaker change.
    expect(texts.some(t => t.includes('change who said it'))).toBe(false);
    expect(texts.some(t => t.startsWith('Tap a line to hear it. Long press to correct it.'))).toBe(true);
  });

  it('a dictation whose audio is gone says so without promising a speaker change', async () => {
    const tree = await render({ utterances: dictated, speakers: [], oneVoice: true, onLineActions: jest.fn() });
    const texts = tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);
    expect(texts).toContain('The recording has been deleted. Long press a line to correct it.');
  });
});
