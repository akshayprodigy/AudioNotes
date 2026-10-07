import React from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { text, useTheme, type TypeKey } from '../../theme';

/**
 * Text that a screen reader announces as a heading, so "next heading" walks the meeting's
 * takeaway and sections rather than every line.
 *
 * `Txt` is for ordinary text and carries no role; this is `Txt` with `accessibilityRole="header"`
 * and the same type tokens, so a heading costs nothing in how it looks.
 */
export default function Heading({
  variant = 'sectionTitle',
  color,
  style,
  children,
  numberOfLines,
}: {
  variant?: TypeKey;
  color?: string;
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  numberOfLines?: number;
}) {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      numberOfLines={numberOfLines}
      style={[text(variant, color ?? colors.ink), style]}>
      {children}
    </Text>
  );
}
