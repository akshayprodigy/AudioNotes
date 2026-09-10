// The tap target that turns a generated item into something checkable.
//
// One small component rather than a prop threaded through the tabs: the MOM tab and the Actions
// tab show the same items and both need exactly this behaviour, and the report's test of whether
// minutes are worth forwarding is whether the reader can check them.
//
// The moment it opens is `items.anchor_start_ms`, which is the ENVELOPE of every place the item
// was said — a sentence said at 1:05 and again at 8:20 anchors at 1:05 — so the button lands on
// the FIRST time it was said. That is the moment a reader wants: where the claim came from, not
// where it was repeated. (The envelope's end is an ordering key and a range to draw, never a range
// to play — see Minutes.Item in the Kotlin, which says the same thing to the other side.)
import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Icon from '../../components/Icon';
import { Txt } from '../../components/ui';
import { s, useTheme, type Colors } from '../../theme';

/**
 * mm:ss, or h:mm:ss past the hour. An hour to ninety minutes is an ordinary meeting here.
 *
 * NOT `stamp` from ./shared, and the two are not worth merging. `stamp` zero-pads the minutes so
 * the transcript's timestamp column lines up down the left edge of a list, and it has no hour
 * form at all — "62:05" is what it would say about an item said an hour in. This one is read
 * inline, once, at the end of a sentence, where "0:00" is what a person writes and "00:00" reads
 * like a clock.
 */
export function provenanceLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const sec = total % 60;
  const min = Math.floor(total / 60) % 60;
  const hr = Math.floor(total / 3600);
  const two = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return hr > 0 ? `${hr}:${two(min)}:${two(sec)}` : `${min}:${two(sec)}`;
}

/**
 * "This is where that came from."
 *
 * The tap always switches to the transcript and scrolls to the anchor; it plays from there only
 * when the recording is still on disk. Both halves are the caller's job (see
 * MeetingScreen.openProvenance) because only the caller owns the tab and the player — what this
 * component owns is that the link SURVIVES the audio being discarded. `meetings.audio_retained`
 * goes to 0 when a recording is swept or deleted, and such a meeting keeps its transcript and its
 * item anchors; hiding the button then would take away the checkable half of the feature to
 * punish the user for a retention setting they chose.
 */
export function ProvenanceButton({
  anchorStartMs,
  onOpen,
  canPlay,
}: {
  anchorStartMs: number;
  /** Switch to the transcript, scroll to this moment, and play from it when audio remains. */
  onOpen: (ms: number) => void;
  /** False once the recording has been discarded. The link stays; only playback goes. */
  canPlay: boolean;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const label = provenanceLabel(anchorStartMs);
  return (
    <Pressable
      accessibilityRole="button"
      // Two labels rather than one, because the two do different things and a screen reader
      // announcing "play" on a meeting whose audio is gone is a promise the tap cannot keep.
      accessibilityLabel={canPlay ? `Play from ${label}` : `Show this in the transcript at ${label}`}
      onPress={() => onOpen(anchorStartMs)}
      hitSlop={s(10)}
      style={({ pressed }) => [st.row, { opacity: pressed ? 0.55 : 1 }]}>
      <Icon
        name={canPlay ? 'play' : 'clock'}
        size={s(12)}
        color={colors.inkSoft}
        strokeWidth={2.6}
      />
      {/* Tabular figures so a column of timestamps does not jitter as the digits change. */}
      <Txt variant="chipSoft" color={colors.inkSoft} style={st.time}>
        {label}
      </Txt>
    </Pressable>
  );
}

function makeStyles(_c: Colors) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: s(5), paddingVertical: s(2) },
    time: { fontVariant: ['tabular-nums'] },
  });
}
