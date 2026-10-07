import Storage from '../../native/NativeStorage';
import { PipelineController } from '../PipelineController';

// F14: Speakers' "Regenerate minutes" rewrote `minutes` rows only, which the Actions and Minutes
// tabs of a meeting with items never read, so it did nothing visible. It now also reindexes, which
// is what carries a renamed speaker into search and the vectors. It must not do anything
// destructive on the way: ticks, hand corrections and hand-typed items live in tables it never
// touches (item_done, edits, items) and the test pins that it makes no write to them.
test('regenerating minutes rebuilds the rule rows, then reindexes the meeting, in that order', async () => {
  const order: string[] = [];
  const build = jest.spyOn(PipelineController, 'buildMinutes').mockImplementation(async () => {
    order.push('build');
  });
  (Storage.reindex as jest.Mock).mockImplementation(async () => {
    order.push('reindex');
  });
  await PipelineController.regenerateMinutes('m1');
  expect(order).toEqual(['build', 'reindex']);
  expect(Storage.reindex).toHaveBeenCalledWith('m1');
  build.mockRestore();
});

test('regenerating minutes writes nothing to ticks, corrections or items', async () => {
  const build = jest.spyOn(PipelineController, 'buildMinutes').mockResolvedValue(undefined);
  (Storage.query as jest.Mock).mockClear();
  await PipelineController.regenerateMinutes('m1');
  const sql = (Storage.query as jest.Mock).mock.calls.map(c => String(c[0])).join('\n');
  expect(sql).not.toMatch(/item_done|action_done|edits|items/i);
  build.mockRestore();
});
