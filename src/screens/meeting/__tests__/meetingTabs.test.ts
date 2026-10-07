import { MEETING_TABS, tabKey } from '../meetingTabs';

describe('the meeting tabs', () => {
  test('say Minutes and Transcript, never MOM or Script', () => {
    expect(MEETING_TABS.map(t => t.label)).toEqual(['Summary', 'Minutes', 'Transcript', 'Actions']);
  });

  test('keep the keys that links and route params already use', () => {
    expect(MEETING_TABS.map(t => t.key)).toEqual(['summary', 'mom', 'transcript', 'actions']);
  });

  test('an old link and a new spelling open the same tab', () => {
    expect(tabKey('mom')).toBe('mom');
    expect(tabKey('minutes')).toBe('mom');
    expect(tabKey('transcript')).toBe('transcript');
    expect(tabKey(undefined)).toBe('summary');
  });
});
