import React from 'react';
import { Alert } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import VocabularyScreen from '../VocabularyScreen';
import { TextPrompt } from '../../components/ui';
import { db } from '../../db/queries';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const nav = { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => () => {}) } as any;
const route = { key: 'vocabulary', name: 'Vocabulary', params: undefined } as any;

const rule = (over: Partial<{ id: string; heard: string; meant: string; source: string; uses: number }> = {}) => ({
  id: 'v1', heard: 'in over', meant: 'Innova', source: 'typed', createdAt: 1, uses: 3, ...over,
});

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<VocabularyScreen navigation={nav} route={route} />);
  });
  return tree;
}

const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);

const press = async (tree: renderer.ReactTestRenderer, label: string) => {
  const n = tree.root.findAllByProps({ label }, { deep: false })[0];
  await act(async () => {
    n.props.onPress();
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (db.vocabulary as jest.Mock).mockResolvedValue([]);
  (db.putVocabulary as jest.Mock).mockResolvedValue('v1');
  (db.deleteVocabulary as jest.Mock).mockResolvedValue(undefined);
});
afterEach(() => jest.useRealTimers());

test('empty: the mascot line, and no rule rows', async () => {
  const tree = await render();
  expect(texts(tree)).toContain('No words yet');
  expect(tree.root.findAllByProps({ label: 'Remove' }, { deep: false })).toHaveLength(0);
});

test('a rule row reads heard → meant, its source and its uses', async () => {
  (db.vocabulary as jest.Mock).mockResolvedValue([rule(), rule({ id: 'v2', heard: 'prey', meant: 'Priya', source: 'learned', uses: 1 })]);
  const tree = await render();
  const t = texts(tree);
  expect(t).toContain('“in over” → “Innova”');
  expect(t).toContain('Typed · used 3 times');
  expect(t).toContain('Learned from a correction · used 1 time');
});

test('Add: both fields become a typed rule, and the list reloads', async () => {
  const tree = await render();
  await press(tree, 'Add');
  const prompt = tree.root.findAllByType(TextPrompt).find(p => p.props.visible)!;
  expect(prompt.props.title).toBe('Add a word');
  expect(prompt.props.extraPlaceholder).toBe('What you mean — e.g. Innova');
  await act(async () => prompt.props.onSubmit('in over', 'Innova'));
  expect(db.putVocabulary).toHaveBeenCalledWith('in over', 'Innova', 'typed');
  expect(db.vocabulary).toHaveBeenCalledTimes(2);
});

test('Add with the second field empty stores nothing and says both are needed', async () => {
  const tree = await render();
  await press(tree, 'Add');
  const prompt = tree.root.findAllByType(TextPrompt).find(p => p.props.visible)!;
  await act(async () => prompt.props.onSubmit('in over', ''));
  expect(db.putVocabulary).not.toHaveBeenCalled();
  expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Both are needed');
});

test('Change: a one-field prompt keyed on heard, keeping the source', async () => {
  (db.vocabulary as jest.Mock).mockResolvedValue([rule({ source: 'learned' })]);
  const tree = await render();
  await press(tree, 'Change');
  const prompt = tree.root.findAllByType(TextPrompt).find(p => p.props.visible)!;
  expect(prompt.props.title).toBe('Instead of “in over”');
  expect(prompt.props.initial).toBe('Innova');
  expect(prompt.props.extraPlaceholder).toBeUndefined();
  await act(async () => prompt.props.onSubmit('Innova Ltd', ''));
  expect(db.putVocabulary).toHaveBeenCalledWith('in over', 'Innova Ltd', 'learned');
});

test('Remove asks first; Remove deletes, Cancel does not', async () => {
  (db.vocabulary as jest.Mock).mockResolvedValue([rule()]);
  const tree = await render();
  await press(tree, 'Remove');
  expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Remove “in over” → “Innova”?');
  expect(db.deleteVocabulary).not.toHaveBeenCalled();
  const buttons: any[] = (Alert.alert as jest.Mock).mock.calls[0][2];
  expect(buttons.find(b => b.text === 'Cancel').onPress).toBeUndefined();
  await act(async () => buttons.find(b => b.text === 'Remove').onPress());
  expect(db.deleteVocabulary).toHaveBeenCalledWith('v1');
});
