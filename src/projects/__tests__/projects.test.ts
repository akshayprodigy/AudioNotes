import { PROJECT_EXPLAINER, projectChoices, resolveTyped } from '../projects';

const norm = (n: string) => n.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 32);

describe('projectChoices', () => {
  it('lists existing projects in the order given and marks the ones this meeting is already in', () => {
    const all = [{ name: 'client', n: 3 }, { name: 'weekly', n: 1 }];
    expect(projectChoices(all, ['weekly'])).toEqual([
      { name: 'client', meetings: 3, applied: false },
      { name: 'weekly', meetings: 1, applied: true },
    ]);
  });
});

describe('resolveTyped', () => {
  const all = [{ name: 'client acme' }];
  it('says an unused name will be created', () => {
    expect(resolveTyped('  Launch  Plan ', all, norm)).toEqual({ name: 'launch plan', exists: false });
  });
  it('says a name that matches an existing project (after normalising) will join it', () => {
    expect(resolveTyped('Client ACME', all, norm)).toEqual({ name: 'client acme', exists: true });
  });
  it('is null when nothing usable was typed', () => {
    expect(resolveTyped('   ', all, norm)).toBeNull();
  });
});

it('explains a project in one line, in the words a person uses', () => {
  expect(PROJECT_EXPLAINER).toBe('A project groups meetings so you can see decisions and open actions together.');
  expect(PROJECT_EXPLAINER).not.toMatch(/\b(tag|thread)s?\b/i);
});
