import { labelsFor } from '../meeting/recordLabels';

/**
 * What a typed item wears. The defects it guards: a free-tier item (no record) growing labels
 * it never earned, "Open" shown as if it were news, and a day label the phone and the screen
 * disagree about.
 */
describe('labelsFor', () => {
  it('shows nothing for an unclassified item', () => {
    expect(labelsFor(null)).toEqual({});
    expect(labelsFor({ itemType: null, status: null, dateNorm: null })).toEqual({});
  });

  it('shows the type, a status only when a later turn changed it, and the pinned day', () => {
    expect(labelsFor({ itemType: 'request', status: 'contradicted', dateNorm: null })).toEqual({
      type: 'Request',
      status: 'Contradicted',
    });
    expect(labelsFor({ itemType: 'commitment', status: 'open', dateNorm: Date.UTC(2026, 8, 18) })).toEqual({
      type: 'Commitment',
      day: 'Fri 18 Sep',
    });
  });

  it('says so when the model was not sure', () => {
    expect(labelsFor({ itemType: 'uncertain', status: 'open', dateNorm: null })).toEqual({ type: 'Not sure' });
  });
});
