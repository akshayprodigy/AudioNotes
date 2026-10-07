import fs from 'fs';
import path from 'path';
import { askExplainer, askState, PRO_WITHOUT_THE_WRITER } from '../askAccess';

describe('askState', () => {
  it('is open for Pro on a phone that can run the writer', () => {
    expect(askState({ paid: true, writerBlocked: null })).toBe('open');
  });
  it('is free for a Free person on a capable phone', () => {
    expect(askState({ paid: false, writerBlocked: null })).toBe('free');
  });
  it('knows a phone that cannot run the writer, Free or Pro', () => {
    expect(askState({ paid: false, writerBlocked: 'Needs 4 GB; this phone has 2 GB.' })).toBe('free-weak');
    expect(askState({ paid: true, writerBlocked: 'Needs 4 GB; this phone has 2 GB.' })).toBe('pro-weak');
  });
  it('does not block while it is still finding out', () => {
    expect(askState({ paid: null, writerBlocked: null })).toBe('open');
  });
});

describe('askExplainer', () => {
  it('on Free says what Ask does and offers one Upgrade', () => {
    const e = askExplainer('free', null)!;
    expect(e.title).toBe('Ask this meeting');
    expect(e.body).toMatch(/answer/i);
    expect(e.body).toMatch(/moment/i);
    expect(e.body).toMatch(/Pro/);
    expect(e.upgrade).toBe('Upgrade to Pro');
  });

  it('on a phone that cannot run the writer names what Pro offers there and does not promise Ask', () => {
    const e = askExplainer('free-weak', 'The writer needs 4 GB of memory; this phone has 2 GB.')!;
    expect(e.body).toContain('The writer needs 4 GB of memory; this phone has 2 GB.');
    for (const feature of PRO_WITHOUT_THE_WRITER) expect(e.body).toContain(feature);
    expect(e.body).toMatch(/Ask .*not .*this phone|cannot answer|can't answer/i);
    expect(e.body).not.toMatch(/Ask (is|comes) (included|part of Pro)/i);
    expect(e.upgrade).toBe('Upgrade to Pro');
  });

  it('for Pro on such a phone says why, with nothing to buy', () => {
    const e = askExplainer('pro-weak', 'The writer needs 4 GB of memory; this phone has 2 GB.')!;
    expect(e.body).toContain('The writer needs 4 GB of memory; this phone has 2 GB.');
    expect(e.upgrade).toBeNull();
  });

  it('has nothing to say when Ask opens', () => {
    expect(askExplainer('open', null)).toBeNull();
  });

  it('lists only features the paywall itself promises on a phone without the writer', () => {
    const paywall = fs.readFileSync(path.join(__dirname, '../../PaywallScreen.tsx'), 'utf8');
    const rows = [...paywall.matchAll(/title: '([^']+)'/g)].map(m => m[1]);
    for (const feature of PRO_WITHOUT_THE_WRITER) expect(rows).toContain(feature);
    // And none of the rows the writer delivers.
    expect(PRO_WITHOUT_THE_WRITER).not.toContain('Ask the meeting');
    expect(PRO_WITHOUT_THE_WRITER).not.toContain('Summaries written, not extracted');
  });
});
