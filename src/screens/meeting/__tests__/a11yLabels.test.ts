import { actionA11yLabel, plainA11yLabel, tabA11yLabel } from '../a11yLabels';

describe('actionA11yLabel', () => {
  it('reads text, owner, due and state', () => {
    expect(actionA11yLabel('I will send the signed quote — Priya (due Wednesday)', false)).toBe(
      'I will send the signed quote. Owner Priya. Due Wednesday. Not done',
    );
    expect(actionA11yLabel('I will send the signed quote — Priya (due Wednesday)', true)).toBe(
      'I will send the signed quote. Owner Priya. Due Wednesday. Done',
    );
  });

  it('says No owner yet for an action nobody owns, and nothing about a missing due date', () => {
    expect(actionA11yLabel('Book the room — Unassigned', false)).toBe('Book the room. No owner yet. Not done');
    expect(actionA11yLabel('Book the room', false)).toBe('Book the room. No owner yet. Not done');
  });

  it('does not double a full stop', () => {
    expect(actionA11yLabel('Send it. — Sam', false)).toBe('Send it. Owner Sam. Not done');
  });

  it('says nothing about progress where the surface does not know it', () => {
    expect(actionA11yLabel('Send it — Sam')).toBe('Send it. Owner Sam.');
  });
});

describe('plainA11yLabel and tabA11yLabel', () => {
  it('a decision reads as what it says', () => {
    expect(plainA11yLabel('we will ship friday.')).toBe('We will ship friday');
  });
  it('a tab says its place', () => {
    expect(tabA11yLabel('Minutes', 1, 4)).toBe('Minutes, tab 2 of 4');
  });
});
