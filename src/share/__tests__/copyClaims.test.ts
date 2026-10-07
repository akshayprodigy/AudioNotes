import fs from 'fs';
import path from 'path';

/**
 * No in-app string, export string or landing line may promise how fast the notes appear.
 *
 * The time between "stop" and "notes ready" depends on the phone (whisper-base runs below real
 * time on a cheap one and the backlog is serial), and nobody has measured it across phones, so
 * "the moment it ends" was a claim with nothing under it (Workstream E, 7 Oct 2026). The Play
 * store caption in docs/store/tools/aso.py is store art and is the founder's to change; it is not
 * scanned here.
 */
const ROOT = path.resolve(__dirname, '../../..');
const CLAIMS = [
  'the moment it ends',
  'the moment the meeting ends',
  'the moment you stop',
  'as soon as the meeting ends',
  'as soon as you stop',
];
const ROOTS = ['src', 'android/app/src/main', 'server/app'];
const SKIP = new Set(['node_modules', '__tests__', 'graphify-out', 'build', '.git']);
const EXT = /\.(ts|tsx|kt|py|html|js|xml|json)$/;

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (EXT.test(e.name)) yield p;
  }
}

describe('unmeasured speed claims', () => {
  it('appear nowhere in the app, the export, or the landing page', () => {
    const hits: string[] = [];
    for (const r of ROOTS) {
      for (const f of walk(path.join(ROOT, r))) {
        const text = fs.readFileSync(f, 'utf8').toLowerCase();
        for (const c of CLAIMS) if (text.includes(c)) hits.push(`${path.relative(ROOT, f)}: ${c}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the scan really reads files (it is not passing on an empty walk)', () => {
    const n = [...walk(path.join(ROOT, 'src/share'))].length;
    expect(n).toBeGreaterThan(3);
    expect([...walk(path.join(ROOT, 'server/app'))].some(f => f.endsWith('landing.py'))).toBe(true);
  });
});
