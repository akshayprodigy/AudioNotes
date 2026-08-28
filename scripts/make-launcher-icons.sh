#!/usr/bin/env bash
#
# Regenerate the Android launcher icons from the SVG masters in assets/logo/.
#
# The masters are transcriptions of the Mascot geometry in src/components/Mascot.tsx, so the icon
# on the home screen is the same character the app draws while it is working. Rendered from vector
# at every density rather than resampled from one bitmap, which is what keeps the 48px mdpi icon
# from going soft.
#
# Needs Inkscape (brew install --cask inkscape).
#
#   ./scripts/make-launcher-icons.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."
SRC=assets/logo
RES=android/app/src/main/res

INKSCAPE=${INKSCAPE:-$(command -v inkscape || true)}
if [ -z "$INKSCAPE" ]; then
  echo "inkscape not found. brew install --cask inkscape" >&2
  exit 1
fi

render() { # svg out px
  "$INKSCAPE" "$1" --export-type=png --export-filename="$2" -w "$3" -h "$3" >/dev/null 2>&1
  echo "  $2 (${3}px)"
}

# Legacy icons, for launchers older than adaptive-icon support. They carry their own background,
# because nothing masks them.
echo "legacy:"
for spec in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  d=${spec%%:*}; px=${spec##*:}
  mkdir -p "$RES/mipmap-$d"
  render "$SRC/ic_launcher.svg"       "$RES/mipmap-$d/ic_launcher.png"       "$px"
  render "$SRC/ic_launcher_round.svg" "$RES/mipmap-$d/ic_launcher_round.png" "$px"
done

# Adaptive foreground. 108dp canvas; the launcher may mask anything outside the middle 72dp, and
# the master already keeps the character inside that.
echo "adaptive foreground:"
for spec in mdpi:108 hdpi:162 xhdpi:216 xxhdpi:324 xxxhdpi:432; do
  d=${spec%%:*}; px=${spec##*:}
  render "$SRC/ic_launcher_foreground.svg" "$RES/mipmap-$d/ic_launcher_foreground.png" "$px"
done

# iOS. The set ships empty in the React Native template; these are the sizes Xcode asks for.
# Flattened to remove the alpha channel, which the App Store rejects on an app icon.
echo "ios:"
IOS=ios/AudioNotes/Images.xcassets/AppIcon.appiconset
mkdir -p "$IOS"
for px in 40 58 60 80 87 120 180 1024; do
  render "$SRC/ios_app_icon.svg" "$IOS/icon-$px.png" "$px"
done
python3 "$(dirname "$0")/flatten-ios-icons.py" "$IOS"

echo "done."
