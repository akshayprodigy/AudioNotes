import React from 'react';
import { StyleSheet, View } from 'react-native';
import Icon from '../components/Icon';
import { Raised, Txt } from '../components/ui';
import { radius, s, useTheme } from '../theme';

/**
 * The Library's way into Pro, on a Free phone only. Filled, so it reads as the one place to buy
 * rather than one more tool, and the same height as the icon buttons beside it so the header stays
 * one row. It takes the Actions button's slot: on Free that button only ever opened the paywall.
 */
export default function ProPill({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="button" accessibilityLabel="Get Pro">
      <Raised
        edge={colors.primaryEdge}
        gradient={{ from: colors.primaryTop, to: colors.primary }}
        rad={radius.md}
        depth={3}
        onPress={onPress}>
        <View style={st.body}>
          <Icon name="ai" size={s(16)} color={colors.onPrimary} strokeWidth={2.6} />
          <Txt variant="metaBlack" color={colors.onPrimary}>
            Pro
          </Txt>
        </View>
      </Raised>
    </View>
  );
}

const st = StyleSheet.create({
  body: { height: s(40), flexDirection: 'row', alignItems: 'center', gap: s(5), paddingHorizontal: s(12) },
});
