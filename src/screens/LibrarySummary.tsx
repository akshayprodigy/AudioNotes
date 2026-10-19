import React from 'react';
import { PixelRatio, Pressable, StyleSheet, View } from 'react-native';
import { Raised, Txt } from '../components/ui';
import Icon from '../components/Icon';
import type { AllowanceStatus } from '../native/NativeLicence';
import { radius, s, useTheme } from '../theme';
import { summaryStats, type Stat } from './summaryStats';

/** Above this the three columns do not fit a phone's width, and the strip becomes a list. */
const STACK_AT_FONT_SCALE = 1.3;

/**
 * The Library's numbers: meetings saved, minutes captured and, on a Free phone, how many of the
 * month's meetings are left. One card under the title instead of a sentence squeezed beside four
 * buttons. Read as one thing by a screen reader (one sentence), not as nine fragments.
 * On a Free phone, given [onUpgrade], the whole strip opens the Pro screen.
 */
export default function LibrarySummary({
  saved,
  capturedMin,
  allowance,
  onUpgrade,
}: {
  saved: number;
  capturedMin: number;
  allowance: AllowanceStatus | null;
  onUpgrade?: () => void;
}) {
  const { colors } = useTheme();
  const stats = summaryStats(saved, capturedMin, allowance);
  const stacked = PixelRatio.getFontScale() > STACK_AT_FONT_SCALE;
  const spoken = stats.map(x => x.spoken).join('. ') + '.';
  // On Free the strip is also the way to Pro: the FREE LEFT figure is where somebody notices the
  // count. Pro has no free cell, so it never gets the link.
  const upgrade = onUpgrade && stats.some(x => x.key === 'free') ? onUpgrade : undefined;

  const figure = (stat: Stat) => (
    <View style={st.figure}>
      {stat.parts.map((p, i) => (
        <View key={i} style={st.part}>
          <Txt variant="statNum" color={stat.spent ? colors.warningDeep : colors.ink}>
            {p.value}
          </Txt>
          {p.unit ? (
            <Txt variant="chipSoft" color={colors.inkDim} style={st.unit}>
              {p.unit}
            </Txt>
          ) : null}
        </View>
      ))}
    </View>
  );

  return (
    <Pressable
      style={st.wrap}
      accessible
      accessibilityRole={upgrade ? 'button' : undefined}
      accessibilityLabel={upgrade ? `${spoken} Go unlimited with Pro.` : spoken}
      testID="library-summary"
      disabled={!upgrade}
      onPress={upgrade}>
      <Raised edge={colors.line} fill={colors.card} rad={radius.lg} depth={4} pressable={false}>
        <View style={stacked ? st.col : st.row} importantForAccessibility="no-hide-descendants">
          {stats.map((stat, i) => (
            <View
              key={stat.key}
              style={[
                stacked ? st.cellStacked : st.cell,
                i > 0 && (stacked ? st.ruleTop : st.ruleLeft),
                i > 0 && { borderColor: colors.line },
              ]}>
              <Txt variant="overlineSm" color={colors.inkFaint}>
                {stat.label}
              </Txt>
              {figure(stat)}
              {stat.caption ? (
                <Txt variant="chipSoft" color={colors.inkDim}>
                  {stat.caption}
                </Txt>
              ) : null}
            </View>
          ))}
        </View>
        {upgrade ? (
          <View style={[st.upgrade, { borderColor: colors.line }]} importantForAccessibility="no-hide-descendants">
            <Txt variant="chip" color={colors.primaryDeep}>
              Go unlimited with Pro
            </Txt>
            <Icon name="chevronRight" size={s(14)} color={colors.primaryDeep} strokeWidth={2.6} />
          </View>
        ) : null}
      </Raised>
    </Pressable>
  );
}

const st = StyleSheet.create({
  wrap: { marginHorizontal: s(20), marginTop: s(14), marginBottom: s(14) },
  row: { flexDirection: 'row' },
  col: {},
  cell: { flex: 1, paddingVertical: s(14), paddingHorizontal: s(14), gap: s(4) },
  cellStacked: { paddingVertical: s(12), paddingHorizontal: s(16), gap: s(2) },
  ruleLeft: { borderLeftWidth: StyleSheet.hairlineWidth },
  ruleTop: { borderTopWidth: StyleSheet.hairlineWidth },
  figure: { flexDirection: 'row', alignItems: 'baseline', gap: s(5), flexWrap: 'wrap' },
  part: { flexDirection: 'row', alignItems: 'baseline', gap: s(3) },
  unit: {},
  upgrade: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: s(4), paddingVertical: s(10), borderTopWidth: StyleSheet.hairlineWidth },
});
