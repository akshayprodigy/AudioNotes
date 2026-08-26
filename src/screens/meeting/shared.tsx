import React from 'react';
import { StyleSheet, View } from 'react-native';
import Icon, { type IconName } from '../../components/Icon';
import { Badge, Raised, Txt } from '../../components/ui';
import { radius, s, tilt, type Colors } from '../../theme';
import type { Minute } from '../../pipeline/types';

/**
 * Pieces shared by more than one meeting tab. Moved out of MeetingScreen when it split, unchanged —
 * they encode the icon and colour mapping the whole screen depends on.
 */

export function kindMeta(
  kind: string,
  c: Colors,
): { label: string; color: string; soft: string; icon: IconName } {
  switch (kind) {
    case 'action':
      return { label: 'ACTION', color: c.warning, soft: c.warningSoft, icon: 'check' };
    case 'decision':
      return { label: 'DECISION', color: c.primary, soft: c.primarySoft, icon: 'check' };
    case 'question':
      return { label: 'OPEN QUESTION', color: c.success, soft: c.successSoft, icon: 'help' };
    default:
      return { label: 'NOTE', color: c.inkSoft, soft: c.cardAlt, icon: 'list' };
  }
}

/**
 * Avatar initials. "First two letters" gives every auto-named speaker "SP" — a column of
 * identical circles carrying no information — because they are all "Speaker N". For generated
 * names the digit is the distinguishing part; a renamed speaker gets proper initials.
 */
export function initials(name: string): string {
  const gen = name.match(/^Speaker\s*(\d+)$/i);
  if (gen) return `S${gen[1]}`;
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[w.length - 1][0]).toUpperCase();
}

/** Minutes are padded so the transcript's timestamp column lines up: 05:07, not 5:07. */
export const stamp = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};

/** One extracted item: kind badge, icon, and the quoted text. Used by Summary and MOM. */
export function MinuteCard({ m, i, colors }: { m: Minute; i: number; colors: Colors }) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const meta = kindMeta(m.kind, colors);
  return (
    <View style={st.row}>
      <View style={[st.icon, { backgroundColor: meta.soft }]}>
        <Icon name={meta.icon} size={s(19)} color={meta.color} strokeWidth={2.8} />
      </View>
      <View style={st.flex}>
        <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5} rotate={tilt(i)}>
          <View style={st.card}>
            <Badge label={meta.label} color={meta.color} soft={meta.soft} small />
            <Txt variant="minuteBody" style={st.text}>
              {m.content}
            </Txt>
          </View>
        </Raised>
      </View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    row: { flexDirection: 'row', gap: s(10), alignItems: 'flex-start' },
    icon: {
      width: s(38),
      height: s(38),
      borderRadius: s(12),
      alignItems: 'center',
      justifyContent: 'center',
    },
    card: { padding: s(14), gap: s(8) },
    text: { marginTop: s(2) },
  });
}
