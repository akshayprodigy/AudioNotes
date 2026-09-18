import React from 'react';
import { Alert, TextInput } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import SpeakersScreen from '../SpeakersScreen';
import { db } from '../../db/queries';
import { entitlement } from '../../billing/trial';
import { SoftButton, Txt } from '../../components/ui';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../pipeline/PipelineController', () => ({ PipelineController: { regenerateMinutes: jest.fn() } }));
jest.mock('../../billing/trial', () => ({ entitlement: jest.fn() }));

const nav = { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as never;
const route = { key: 'sp', name: 'Speakers', params: { meetingId: 'm1' } } as never;

const base = {
  id: '', meetingId: 'm1', clusterLabel: 'S0', displayName: '',
  suggestedPerson: null, suggestedName: null,
};
const s1 = { ...base, id: 's1', displayName: 'Speaker 1', suggestedPerson: 'p1', suggestedName: 'Priya' };
const s2 = { ...base, id: 's2', displayName: 'Speaker 2', suggestedPerson: null, suggestedName: null };

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<SpeakersScreen navigation={nav} route={route} />);
  });
  return tree;
}

const childText = (n: any) => {
  const c = n.props.children;
  return Array.isArray(c) ? c.map(String).join('') : String(c ?? '');
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  (db.speakers as jest.Mock).mockResolvedValue([s1, s2]);
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  (db.setSetting as jest.Mock).mockResolvedValue(undefined);
  (db.renameSpeaker as jest.Mock).mockResolvedValue(undefined);
  (db.rememberVoice as jest.Mock).mockResolvedValue({ remembered: true });
  (db.answerSuggestion as jest.Mock).mockResolvedValue({ name: 'Priya' });
  (entitlement as jest.Mock).mockResolvedValue({ paid: true });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

test('a suggested speaker shows the line and both buttons', async () => {
  const tree = await render();
  const line = tree.root.findAllByType(Txt).find(t => childText(t) === 'Sounds like Priya?');
  expect(line).toBeDefined();
  expect(tree.root.findByProps({ accessibilityLabel: 'Yes, this is Priya' })).toBeDefined();
  expect(tree.root.findByProps({ accessibilityLabel: 'No, not Priya' })).toBeDefined();
  const allSounds = tree.root
    .findAllByType(Txt)
    .filter(t => childText(t).includes('Sounds like'));
  expect(allSounds).toHaveLength(1);
});

test('Yes answers true and reloads', async () => {
  const tree = await render();
  const yes = tree.root.findByProps({ accessibilityLabel: 'Yes, this is Priya' });
  await act(async () => { yes.findByType(SoftButton).props.onPress(); });
  expect(db.answerSuggestion).toHaveBeenCalledWith('s1', true);
  expect(db.speakers).toHaveBeenCalledTimes(2);
});

test('No answers false', async () => {
  const tree = await render();
  const no = tree.root.findByProps({ accessibilityLabel: 'No, not Priya' });
  await act(async () => { no.findByType(SoftButton).props.onPress(); });
  expect(db.answerSuggestion).toHaveBeenCalledWith('s1', false);
});

test('a rename writes the name then remembers it', async () => {
  const tree = await render();
  const input = tree.root.findAllByType(TextInput).find(t => t.props.defaultValue === 'Speaker 2')!;
  await act(async () => { input.props.onEndEditing({ nativeEvent: { text: 'Priya' } }); });
  expect(db.renameSpeaker).toHaveBeenCalledWith('s2', 'Priya');
  expect(db.rememberVoice).toHaveBeenCalledWith('s2', 'Priya');

  await act(async () => { input.props.onEndEditing({ nativeEvent: { text: 'Speaker 9' } }); });
  expect(db.renameSpeaker).toHaveBeenCalledWith('s2', 'Speaker 9');
  expect(db.rememberVoice).not.toHaveBeenCalledWith('s2', 'Speaker 9');

  await act(async () => { input.props.onEndEditing({ nativeEvent: { text: '   ' } }); });
  expect(db.renameSpeaker).toHaveBeenCalledWith('s2', '   ');
  expect(db.rememberVoice).not.toHaveBeenCalledWith('s2', '   ');
});

test('the one-time card appears once and "Turn on" writes both keys', async () => {
  const tree = await render();
  const input = tree.root.findAllByType(TextInput).find(t => t.props.defaultValue === 'Speaker 2')!;
  await act(async () => { input.props.onEndEditing({ nativeEvent: { text: 'Priya' } }); });
  expect(Alert.alert).toHaveBeenCalledTimes(1);
  const buttons: any[] = (Alert.alert as jest.Mock).mock.calls[0][2];
  const turnOn = buttons.find(b => b.text === 'Turn on');
  await act(async () => { turnOn.onPress(); });
  expect(db.setSetting).toHaveBeenCalledWith('voices_remember', '1');
  expect(db.setSetting).toHaveBeenCalledWith('voices_prompted', '1');
  expect(db.rememberVoice).toHaveBeenCalledTimes(2);
  expect(db.rememberVoice).toHaveBeenNthCalledWith(1, 's2', 'Priya');
  expect(db.rememberVoice).toHaveBeenNthCalledWith(2, 's2', 'Priya');
});

test('"Not now" writes only voices_prompted', async () => {
  const tree = await render();
  const input = tree.root.findAllByType(TextInput).find(t => t.props.defaultValue === 'Speaker 2')!;
  await act(async () => { input.props.onEndEditing({ nativeEvent: { text: 'Priya' } }); });
  expect(Alert.alert).toHaveBeenCalledTimes(1);
  const buttons: any[] = (Alert.alert as jest.Mock).mock.calls[0][2];
  const notNow = buttons.find(b => b.text === 'Not now');
  await act(async () => { notNow.onPress(); });
  expect(db.setSetting).toHaveBeenCalledTimes(1);
  expect(db.setSetting).toHaveBeenCalledWith('voices_prompted', '1');
});

test('no card when already prompted', async () => {
  (db.getSetting as jest.Mock).mockImplementation(async (k: string) =>
    k === 'voices_prompted' ? '1' : null);
  const tree = await render();
  const input = tree.root.findAllByType(TextInput).find(t => t.props.defaultValue === 'Speaker 2')!;
  await act(async () => { input.props.onEndEditing({ nativeEvent: { text: 'Priya' } }); });
  expect(Alert.alert).not.toHaveBeenCalled();
});

test('no card when the setting is already set', async () => {
  (db.getSetting as jest.Mock).mockImplementation(async (k: string) =>
    k === 'voices_remember' ? '0' : null);
  const tree = await render();
  const input = tree.root.findAllByType(TextInput).find(t => t.props.defaultValue === 'Speaker 2')!;
  await act(async () => { input.props.onEndEditing({ nativeEvent: { text: 'Priya' } }); });
  expect(Alert.alert).not.toHaveBeenCalled();
});

test('no card on free', async () => {
  (entitlement as jest.Mock).mockResolvedValue({ paid: false });
  const tree = await render();
  const input = tree.root.findAllByType(TextInput).find(t => t.props.defaultValue === 'Speaker 2')!;
  await act(async () => { input.props.onEndEditing({ nativeEvent: { text: 'Priya' } }); });
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(db.rememberVoice).toHaveBeenCalledWith('s2', 'Priya');
});
