import { planCompare } from '../planCompare';

describe('planCompare', () => {
  it('on a phone that runs everything, lists every row', () => {
    const rows = planCompare(true, true);
    expect(rows.map(r => r.key)).toEqual(['meetings', 'length', 'transcript', 'minutes', 'search', 'export']);
    expect(rows.find(r => r.key === 'search')!.pro).toBe('By meaning, and Ask');
  });

  it('promises neither the transcriber nor the written minutes where the phone runs neither', () => {
    const rows = planCompare(false, false);
    expect(rows.map(r => r.key)).toEqual(['meetings', 'length', 'search', 'export']);
    expect(rows.find(r => r.key === 'search')!.pro).toBe('By meaning');
  });

  it("states Free's limits as the allowance does", () => {
    const rows = planCompare(false, false);
    expect(rows[0]).toEqual({ key: 'meetings', label: 'Meetings', free: '5 a month', pro: 'Unlimited' });
    expect(rows[1]).toEqual({ key: 'length', label: 'Length', free: 'Up to 1 hour', pro: 'Any length' });
  });
});
