import bundle from '../sampleMeeting.json';
import { extractItems } from '../../pipeline/evidence';
import { extractMinutes } from '../../pipeline/minutes';
import type { Speaker, Utterance } from '../../pipeline/types';

/**
 * The sample meeting is generated (scripts/make-sample-meeting.sh), never edited. These tests are
 * what stop a hand edit from making it say something the app would not: every item must be what
 * the rule extractor produces from the transcript, and every anchor must land on the turn that
 * actually says it.
 */
const speakers = bundle.speakers as unknown as Speaker[];
const utterances = bundle.utterances.map(u => ({ ...u, meetingId: bundle.id })) as unknown as Utterance[];

describe('sample meeting bundle', () => {
  it('is a sample by id and by title', () => {
    expect(bundle.id).toBe('sample-meeting-v1');
    expect(bundle.title).toMatch(/sample/i);
  });

  it('has two named speakers and every line belongs to one of them', () => {
    expect(bundle.speakers.map(s => s.displayName).sort()).toEqual(['Priya', 'Sam']);
    const ids = new Set(bundle.speakers.map(s => s.id));
    for (const u of bundle.utterances) expect(ids.has(u.speakerId)).toBe(true);
  });

  it('runs about a minute, with ordered, non-overlapping turns inside the audio', () => {
    expect(bundle.durationMs).toBeGreaterThan(55_000);
    expect(bundle.durationMs).toBeLessThan(95_000);
    let prevEnd = 0;
    for (const u of bundle.utterances) {
      expect(u.startMs).toBeGreaterThanOrEqual(prevEnd);
      expect(u.endMs).toBeGreaterThan(u.startMs);
      prevEnd = u.endMs;
    }
    expect(prevEnd).toBeLessThanOrEqual(bundle.durationMs);
  });

  it('shows one decision with a price, four actions (one with no owner, one done) and a question', () => {
    const by = (k: string) => bundle.items.filter(i => i.kind === k);
    expect(by('decision')).toHaveLength(1);
    expect(by('decision')[0].text).toContain('$4,500');
    expect(by('question')).toHaveLength(1);
    const actions = by('action');
    expect(actions).toHaveLength(4);
    expect(actions.filter(a => a.text.includes('— Unassigned'))).toHaveLength(1);
    expect(actions.filter(a => a.done)).toHaveLength(1);
    // Every action carries a due date, said in the words of the meeting.
    for (const a of actions) expect(a.text).toMatch(/\(due [^)]+\)$/);
    // The owned ones follow the speaker row, so a rename shows up on them.
    expect(actions.filter(a => a.ownerJson).map(a => JSON.parse(a.ownerJson!).kind)).toEqual([
      'speaker', 'speaker', 'speaker',
    ]);
  });

  it('is exactly what the app\'s own rule extractor writes for that transcript', () => {
    const drafts = extractItems(utterances, speakers);
    expect(bundle.items.map(i => [i.kind, i.text, i.anchorStartMs, i.anchorEndMs])).toEqual(
      drafts.map(d => [d.kind, d.text, d.anchorStartMs, d.anchorEndMs]),
    );
    expect(bundle.minutes).toEqual(extractMinutes(utterances, speakers).map(m => ({ kind: m.kind, content: m.content })));
  });

  it('anchors every item on the turn that says it', () => {
    for (const item of bundle.items) {
      expect(item.sources.length).toBeGreaterThan(0);
      for (const src of item.sources) {
        const turn = bundle.utterances.find(u => u.id === src.utteranceId);
        expect(turn).toBeDefined();
        expect(src.startMs).toBe(turn!.startMs);
        expect(src.endMs).toBe(turn!.endMs);
        // The item's sentence is inside that turn, at the stated offsets.
        const said = turn!.text.slice(src.charStart, src.charEnd);
        expect(item.text.startsWith(said)).toBe(true);
      }
      expect(item.anchorStartMs).toBe(Math.min(...item.sources.map(s => s.startMs)));
      expect(item.anchorEndMs).toBe(Math.max(...item.sources.map(s => s.endMs)));
    }
  });
});
