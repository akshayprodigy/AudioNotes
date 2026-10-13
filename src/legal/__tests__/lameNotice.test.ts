import fs from 'fs';
import path from 'path';
import { LICENCE_TEXTS, NOTICES } from '../notices';

/**
 * LAME is LGPL. Two of its obligations are visible in the app: the licence text travels with it, and
 * a person is told where the source is and that the library can be replaced. Settings -> Open-source
 * notices renders whatever is in NOTICES, so this is the file that decides whether it is there.
 */
describe('the LAME notice', () => {
  const lame = NOTICES.find(n => n.name.startsWith('LAME'));

  it('is listed among what ships in the app, under the LGPL', () => {
    expect(lame).toBeDefined();
    expect(lame!.where).toBe('app');
    expect(lame!.licence).toBe('LGPL-2.0');
    expect(lame!.by).toMatch(/Copyright/);
  });

  it('links the project and says the library can be replaced', () => {
    expect(lame!.used).toContain('https://lame.sourceforge.io');
    expect(lame!.used).toMatch(/replaced/);
    expect(lame!.used).toContain('libmp3lame.so');
  });

  it('carries the whole licence text, read from the vendored COPYING', () => {
    const copying = fs
      .readFileSync(path.resolve(__dirname, '../../../cpp/third_party/lame/COPYING'), 'utf8')
      .replace(/^\n+|\n+$/g, '');
    expect(LICENCE_TEXTS['LGPL-2.0']).toBe(copying);
    expect(LICENCE_TEXTS['LGPL-2.0']).toMatch(/GNU LIBRARY GENERAL PUBLIC LICENSE/);
  });
});
