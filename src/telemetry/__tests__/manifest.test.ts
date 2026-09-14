/**
 * The two manifest switches that keep Crashlytics OFF before any JavaScript runs.
 *
 * Both are load-bearing and neither is visible to any runtime test, because they act before the
 * process has a JS engine to test from. Google's SDK reads the first; react-native-firebase's init
 * provider reads the second, defaults it to TRUE, and calls setCrashlyticsCollectionEnabled with
 * the answer — overriding the first. The Galaxy A07 showed what one key alone buys: collection on
 * from process start, and a settings fetch to Google's server, on a phone nobody had consented on.
 *
 * Reads the manifest as text rather than trusting a comment about it. A key that is present but
 * "true", or present under a misspelt name, fails here; so does removing either one.
 */
import * as fs from 'fs';
import * as path from 'path';

const manifest = fs.readFileSync(
  path.join(__dirname, '../../../android/app/src/main/AndroidManifest.xml'),
  'utf8',
);

function metaValue(name: string): string | null {
  const re = new RegExp(
    `<meta-data\\s+android:name="${name}"\\s+android:value="([^"]*)"\\s*/>`,
  );
  const m = manifest.match(re);
  return m ? m[1] : null;
}

describe('AndroidManifest crash-reporting switches', () => {
  it("keeps Google's own Crashlytics switch off before consent", () => {
    expect(metaValue('firebase_crashlytics_collection_enabled')).toBe('false');
  });

  it("keeps react-native-firebase's auto-collection switch off before consent", () => {
    // Without this one the wrapper's init provider turns collection ON at process start,
    // regardless of the key above.
    expect(metaValue('rnfirebase_crashlytics_auto_collection_enabled')).toBe('false');
  });

  it('keeps analytics off, so a later Firebase dependency cannot switch it on quietly', () => {
    expect(metaValue('firebase_analytics_collection_enabled')).toBe('false');
  });
});
