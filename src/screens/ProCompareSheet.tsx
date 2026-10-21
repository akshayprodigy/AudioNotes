import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ModelManager from '../native/NativeModelManager';
import { Button, SoftButton, Txt } from '../components/ui';
import { planCompare } from '../billing/planCompare';
import { statusLine } from '../billing/allowanceCopy';
import type { AllowanceStatus } from '../native/NativeLicence';
import { runnable } from './deviceFit';
import { radius, s, useTheme } from '../theme';

/**
 * What the Library's count opens on a Free phone: Free beside Pro, and one way on to buy it.
 *
 * It replaces the header's Pro pill (founder, 21 Oct: the pill cluttered the header, and the count
 * is where somebody already looks when they wonder about the limit). It reads the catalog each
 * time it opens, so it promises only what this phone runs.
 */
export default function ProCompareSheet({
  visible,
  allowance,
  onClose,
  onGetPro,
}: {
  visible: boolean;
  allowance: AllowanceStatus | null;
  onClose: () => void;
  onGetPro: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [runs, setRuns] = useState({ writer: false, small: false });

  useEffect(() => {
    if (!visible) return;
    ModelManager.list()
      .then(r => {
        const here = runnable<{ id: string; kind: string; unsupportedReason?: string | null }>(JSON.parse(r));
        setRuns({
          writer: here.some(m => m.id === 'llm-qwen'),
          small: here.some(m => m.id === 'whisper-small'),
        });
      })
      .catch(() => {});
  }, [visible]);

  const line = statusLine(allowance);
  const rows = planCompare(runs.writer, runs.small);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={st.fill} onPress={onClose} accessibilityLabel="Dismiss">
        <View style={[st.fill, st.scrim, { backgroundColor: colors.scrim }]} />
      </Pressable>
      <View
        testID="pro-compare"
        style={[st.card, { backgroundColor: colors.card, paddingBottom: insets.bottom + s(16) }]}>
        <View style={[st.grip, { backgroundColor: colors.line }]} />
        <Txt variant="sectionTitle">Free and Pro</Txt>
        {line ? (
          <Txt variant="chip" color={colors.inkDim} style={st.status}>
            {line}
          </Txt>
        ) : null}
        <View style={[st.row, st.headRow]}>
          <View style={st.label} />
          <Txt variant="overlineSm" color={colors.inkFaint} style={st.col}>
            FREE
          </Txt>
          <Txt variant="overlineSm" color={colors.primaryDeep} style={st.col}>
            PRO
          </Txt>
        </View>
        {rows.map(r => (
          <View
            key={r.key}
            testID={`compare-${r.key}`}
            accessible
            accessibilityLabel={`${r.label}: Free, ${r.free}. Pro, ${r.pro}.`}
            style={[st.row, { borderTopColor: colors.line }]}>
            <Txt variant="chip" color={colors.inkSoft} style={st.label}>
              {r.label}
            </Txt>
            <Txt variant="chip" color={colors.ink} style={st.col}>
              {r.free}
            </Txt>
            <Txt variant="chip" color={colors.primaryDeep} style={st.col}>
              {r.pro}
            </Txt>
          </View>
        ))}
        <View style={st.actions}>
          <Button label="Get Pro" icon="ai" onPress={onGetPro} full />
          <SoftButton label="Not now" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { opacity: 0.38 },
  card: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: s(20),
    paddingTop: s(10),
  },
  grip: { alignSelf: 'center', width: s(42), height: s(5), borderRadius: 999, marginBottom: s(14) },
  status: { marginTop: s(4) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: s(8),
    paddingVertical: s(9),
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  headRow: { marginTop: s(14), borderTopWidth: 0 },
  label: { flex: 1.1 },
  col: { flex: 1 },
  actions: { marginTop: s(16), gap: s(8) },
});
