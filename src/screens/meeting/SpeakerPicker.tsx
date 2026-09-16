import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { Speaker } from '../../pipeline/types';
import Icon from '../../components/Icon';
import { Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Scope } from './speakerRepair';

const SCOPES: { key: Scope; label: string }[] = [
  { key: 'line', label: 'Just this line' },
  { key: 'rest', label: 'From here to the end of the turn' },
  { key: 'turn', label: 'The whole turn' },
];

const TITLE_CHARS = 40;

/**
 * Who said it. One row per speaker, the current one marked, then "Someone new"; three scope chips
 * when the line sits in a turn with company. Splitting and merging turns are both this sheet —
 * see speakerRepair.ts.
 */
export default function SpeakerPicker({
  visible,
  lineText,
  speakers,
  currentId,
  scopes,
  onPick,
  onNew,
  onClose,
}: {
  visible: boolean;
  lineText: string;
  speakers: Speaker[];
  currentId: string | null;
  /** Show the scope chips. False for a single-line turn or a turn-head tap: the scope is the turn. */
  scopes: boolean;
  onPick: (speakerId: string, scope: Scope) => void;
  onNew: (scope: Scope) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const st = makeStyles(colors);
  const [scope, setScope] = useState<Scope>(scopes ? 'line' : 'turn');
  useEffect(() => {
    if (visible) setScope(scopes ? 'line' : 'turn');
  }, [visible, scopes]);
  const clipped = lineText.length > TITLE_CHARS ? lineText.slice(0, TITLE_CHARS).trimEnd() + '…' : lineText;
  const title = `Who said “${clipped}”?`;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={st.backdrop} onPress={onClose} accessibilityLabel="Dismiss">
        <View style={[st.scrim, { backgroundColor: colors.scrim }]} />
      </Pressable>
      <View style={[st.card, { backgroundColor: colors.card }]}>
        <View style={[st.grip, { backgroundColor: colors.line }]} />
        <Txt variant="sectionTitle" style={st.title}>
          {title}
        </Txt>
        {scopes ? (
          <View style={st.chips}>
            {SCOPES.map(x => {
              const on = scope === x.key;
              return (
                <Pressable
                  key={x.key}
                  accessibilityRole="button"
                  accessibilityLabel={x.label}
                  accessibilityState={{ selected: on }}
                  onPress={() => setScope(x.key)}
                  style={[
                    st.chip,
                    { backgroundColor: on ? colors.primarySoft : colors.cardAlt, borderColor: on ? colors.primary : colors.line },
                  ]}>
                  <Txt variant="chipSoft" color={on ? colors.primary : colors.inkSoft}>
                    {x.label}
                  </Txt>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <ScrollView style={st.list}>
          {speakers.map(sp => {
            const on = sp.id === currentId;
            return (
              <Pressable
                key={sp.id}
                accessibilityRole="button"
                accessibilityLabel={sp.displayName}
                accessibilityState={{ selected: on }}
                onPress={() => onPick(sp.id, scope)}
                style={[st.row, { borderBottomColor: colors.line }]}>
                <Txt variant="bodyStrong" color={on ? colors.primary : colors.ink} style={st.flex}>
                  {sp.displayName}
                </Txt>
                {on ? <Icon name="check" size={s(18)} color={colors.primary} strokeWidth={3} /> : null}
              </Pressable>
            );
          })}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Someone new"
            onPress={() => onNew(scope)}
            style={[st.row, { borderBottomColor: 'transparent' }]}>
            <Icon name="plus" size={s(18)} color={colors.primary} strokeWidth={2.6} />
            <Txt variant="bodyStrong" color={colors.primary}>
              Someone new
            </Txt>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

function makeStyles(_c: Colors) {
  return StyleSheet.create({
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    scrim: { flex: 1, opacity: 0.38 },
    card: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      borderTopLeftRadius: radius.sheet,
      borderTopRightRadius: radius.sheet,
      paddingHorizontal: s(20),
      paddingTop: s(10),
      paddingBottom: s(28),
      gap: s(12),
      maxHeight: '70%',
    },
    grip: { alignSelf: 'center', width: s(42), height: s(5), borderRadius: 999, marginBottom: s(4) },
    title: { paddingHorizontal: s(2) },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: s(8) },
    // flexShrink 0: in a wrapping row Android shrank the first chip and cut its text to "Just
    // this" on every opening after the first. A chip keeps its width and wraps to the next line.
    chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: s(12), paddingVertical: s(7), flexShrink: 0 },
    list: { flexGrow: 0 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(10),
      paddingVertical: s(12),
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    flex: { flex: 1 },
  });
}
