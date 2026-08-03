import React from 'react';
import { Animated, Pressable, View, StyleSheet } from 'react-native';
import Icon from './Icon';
import type { Colors } from '../theme';

interface Props {
  level: Animated.Value; // 0..1, driven by onCaptureLevel while recording
  active: boolean; // recording?
  colors: Colors;
  onPress: () => void;
  size?: number;
}

// A record button whose pulse rings, mic icon, and equalizer bars all move with the live mic level,
// so it visibly "captures" the voice instead of showing a static Stop control.
const BAR_MULT = [0.45, 0.75, 1.0, 0.7, 1.0, 0.75, 0.45];

export default function MicVisualizer({ level, active, colors, onPress, size = 190 }: Props) {
  const btn = size * 0.52;
  const fill = active ? colors.danger : colors.primary;

  const ringStyle = (base: number, maxOpacity: number) => ({
    position: 'absolute' as const,
    width: size * base,
    height: size * base,
    borderRadius: (size * base) / 2,
    backgroundColor: fill,
    opacity: active
      ? level.interpolate({ inputRange: [0, 1], outputRange: [0.04, maxOpacity] })
      : 0,
    transform: [{ scale: level.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.15] }) }],
  });

  const iconScale = active
    ? level.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.12] })
    : 1;

  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View style={ringStyle(0.92, 0.14)} />
        <Animated.View style={ringStyle(0.72, 0.22)} />
        <Pressable
          onPress={onPress}
          style={[
            styles.btn,
            { width: btn, height: btn, borderRadius: btn / 2, backgroundColor: fill },
          ]}>
          <Animated.View style={{ transform: [{ scale: iconScale }] }}>
            <Icon name="mic" size={btn * 0.42} color={colors.onPrimary} strokeWidth={2.2} />
          </Animated.View>
        </Pressable>
      </View>

      <View style={styles.eq}>
        {BAR_MULT.map((m, i) => (
          <Animated.View
            key={i}
            style={{
              width: 5,
              height: 34,
              marginHorizontal: 3,
              borderRadius: 3,
              backgroundColor: active ? colors.primary : colors.border,
              transform: [
                {
                  scaleY: active
                    ? level.interpolate({ inputRange: [0, 1], outputRange: [0.18, m] })
                    : 0.18,
                },
              ],
            }}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: { alignItems: 'center', justifyContent: 'center', elevation: 4 },
  eq: { flexDirection: 'row', alignItems: 'center', height: 40, marginTop: 20 },
});
