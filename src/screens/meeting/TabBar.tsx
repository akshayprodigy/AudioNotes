import React from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import { tabA11yLabel } from './a11yLabels';
import { MIN_TOUCH } from './shared';

/**
 * The meeting's tab bar.
 *
 * Its own component rather than the shared Segmented, for what this screen needs of it: each tab
 * says where it is ("Minutes, tab 2 of 4"; the screen reader adds "selected" from the state), is at
 * least 44 dp tall, and wraps onto a second line at large text instead of cutting a word off — a
 * tab label is not allowed to be an ellipsis.
 */
export default function TabBar({
  items,
  value,
  onChange,
  style,
}: {
  items: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[st.track, style]} accessibilityRole="tablist">
      {items.map((it, i) => {
        const on = it.key === value;
        return (
          <Pressable
            key={it.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={tabA11yLabel(it.label, i, items.length)}
            onPress={() => onChange(it.key)}
            style={[st.seg, on && { backgroundColor: colors.card, borderColor: colors.line }]}>
            <Txt variant={on ? 'chip' : 'chipSoft'} color={on ? colors.primaryDeep : colors.inkSoft} style={st.label}>
              {it.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    track: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      backgroundColor: c.cardAlt,
      borderRadius: radius.ctl,
      padding: s(3),
      gap: s(2),
    },
    seg: {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: s(72),
      minHeight: MIN_TOUCH,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: s(6),
      paddingHorizontal: s(6),
      borderRadius: radius.ctl - s(3),
      borderWidth: 1,
      borderColor: 'transparent',
    },
    label: { textAlign: 'center', flexShrink: 1 },
  });
}
