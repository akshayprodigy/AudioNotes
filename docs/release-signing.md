# Release signing

Everything here is about one file you must not lose.

Android identifies an app by the key it was signed with, not by its name or its package. **If the
upload key is lost, no future build can ever update the app on a user's phone** — the only way
forward is a new listing under a new package name, with every install and every review left
behind. That is the whole reason this document exists.

## Get Play App Signing, and the problem mostly goes away

Enrol the app in **Play App Signing** when you create the Play Console listing. Google then holds
the *app signing key* and you hold only an *upload key*. Lose the upload key and Google can reset
it for you; lose an unmanaged signing key and there is no recourse from anyone.

Do this before the first upload. It cannot be added to an existing unmanaged app without Google's
involvement, and there is no reason to take that risk.

## Making the upload key

Once. Then back it up.

```bash
keytool -genkeypair -v \
  -storetype PKCS12 \
  -keystore audionotes-upload.keystore \
  -alias audionotes \
  -keyalg RSA -keysize 4096 \
  -validity 10000 \
  -dname "CN=AudioNotes, O=InnoCore Labs, L=Kolkata, C=IN"
```

`-validity 10000` is about 27 years. Play refuses keys that expire before 2033, and a key that
expires is the same problem as a key that is lost.

Keep the resulting file somewhere that survives a laptop dying — a password manager's file
attachment, or an encrypted backup you actually test restoring. Not in this repository: the root
`.gitignore` excludes `*.keystore` precisely so an accidental `git add -A` cannot commit it.

## Telling Gradle about it

Four properties, set **outside the repository** in `~/.gradle/gradle.properties`:

```properties
AUDIONOTES_STORE_FILE=/absolute/path/to/audionotes-upload.keystore
AUDIONOTES_STORE_PASSWORD=…
AUDIONOTES_KEY_ALIAS=audionotes
AUDIONOTES_KEY_PASSWORD=…
```

`android/app/build.gradle` reads them if they are present, and falls back to the debug key if they
are not — so a developer who has never seen the key can still build and run the app.

In CI, pass them as `-P` flags from secrets and write the keystore to a temporary path, rather
than committing an encrypted copy.

## The guard

`assembleRelease`, `bundleRelease` and `installRelease` refuse to run unless signing is
configured:

```
Release signing is not configured, so this build would be signed with the DEBUG key and Play
would reject it.
```

This exists because the failure it prevents is silent. A debug-signed AAB is rejected at
submission, costing a round trip — and a debug-signed APK handed to a tester establishes a
signature the real build cannot replace without an uninstall, which on this app means deleting
their meetings and re-downloading roughly 1.5 GB of models.

For a throwaway local build — measuring APK size, or checking startup time — say so explicitly:

```bash
./gradlew assembleRelease -PallowDebugSignedRelease=true -PlicencePublicKey=…
```

The flag has to be typed. That is the point.

The same guard also requires `licencePublicKey`; see `billing/LicenceStore.kt` for why a release
without it would hand the paid tier to everyone.

## Checking what you actually built

Never assume. Ask the APK:

```bash
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs \
  android/app/build/outputs/apk/release/app-release.apk
```

`CN=Android Debug` means it is debug-signed and Play will reject it. This is exactly how the
problem was found in the first place — the release block still carried the React Native template's
default, and the build succeeded, so nothing looked wrong until the certificate was printed.

## Release build, in full

```bash
cd android
./gradlew bundleRelease -PlicencePublicKey=<base64 X.509 P-256 public key>
# → app/build/outputs/bundle/release/app-release.aab
```

Play requires the `.aab`. The `.apk` from `assembleRelease` is for local installation and testing
only.
