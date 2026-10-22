import React from 'react';
import renderer, { act } from 'react-test-renderer';
import MinutesTab from '../MinutesTab';

jest.mock('../../../db/queries', () => ({
  db: {
    doneItems: jest.fn().mockResolvedValue(new Set()),
    doneActions: jest.fn().mockResolvedValue(new Set()),
    setItemDone: jest.fn().mockResolvedValue(undefined),
    setActionDone: jest.fn().mockResolvedValue(undefined),
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

const item = (i: number, kind: string, text: string) => ({
  id: `it${i}`, meetingId: 'm1', kind, text, review: 'suggested', genVersion: 'rules@1',
  itemType: null, status: null, ownerJson: null, dateSaid: null, dateNorm: null,
  anchorStartMs: i * 1000, anchorEndMs: i * 1000 + 500, sources: [],
});

const texts = async (items: unknown[]) => {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<MinutesTab items={items as never} minutes={[]} onExport={() => {}} />);
  });
  return tree.root
    .findAll(n => typeof n.props.children === 'string')
    .map(n => n.props.children as string);
};

describe('the Minutes takeaway headline', () => {
  it('is not drawn above a Decisions card that says the same thing', async () => {
    const t = await texts([item(1, 'decision', 'We will ship on Thursday.')]);
    expect(t.some(s => s.startsWith('Decided:'))).toBe(false);
    expect(t.some(s => s.includes('ship on Thursday'))).toBe(true);
  });

  it('stays when there are no decisions, as the next step', async () => {
    const t = await texts([item(1, 'action', 'Send the deck — Priya')]);
    expect(t.some(s => s.startsWith('Next:'))).toBe(true);
  });
});
