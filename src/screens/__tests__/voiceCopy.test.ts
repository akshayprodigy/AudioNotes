import { soundsLike } from '../voiceCopy';

describe('soundsLike', () => {
  test('empty list is empty', () => {
    expect(soundsLike([])).toBe('');
  });

  test('one name', () => {
    expect(soundsLike(['Priya'])).toBe('Sounds like Priya — confirm?');
  });

  test('two names', () => {
    expect(soundsLike(['Priya', 'Ravi'])).toBe('Sounds like Priya and Ravi — confirm?');
  });

  test('three names collapses to "and 1 more"', () => {
    expect(soundsLike(['Priya', 'Ravi', 'Sam'])).toBe(
      'Sounds like Priya, Ravi and 1 more — confirm?',
    );
  });

  test('five names collapses to "and 3 more"', () => {
    expect(
      soundsLike(['Priya', 'Ravi', 'Sam', 'Anil', 'Nina']),
    ).toBe('Sounds like Priya, Ravi and 3 more — confirm?');
  });
});
