import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Txt } from '../components/ui';
import { confirmDestructive } from '../components/confirm';
import { radius, s, useTheme, type Colors } from '../theme';
import { deleteSample } from './seedSample';
import { isSampleId, sampleBannerText } from './sampleId';

/**
 * The line across the top of the sample meeting, and the way to remove it. Renders nothing for
 * any other meeting, so the screen can place it unconditionally.
 *
 * Deleting is always allowed and costs nothing: the Library offers "See the sample again".
 */
export default function SampleBanner({
  meetingId,
  onDeleted,
}: {
  meetingId: string;
  onDeleted: () => void;
}) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  if (!isSampleId(meetingId)) return null;

  const remove = () =>
    confirmDestructive({
      title: 'Delete the sample?',
      message: 'The sample meeting and its audio are removed from this phone. You can bring it back from the Library.',
      confirmLabel: 'Delete sample',
      onConfirm: () => {
        deleteSample()
          .catch(() => {})
          .then(onDeleted);
      },
    });

  return (
    <View style={st.banner} accessibilityRole="summary">
      <Txt variant="sub" color={colors.primaryDeep}>
        {sampleBannerText}
      </Txt>
      <Pressable accessibilityRole="button" accessibilityLabel="Delete sample" onPress={remove} style={st.action}>
        <Txt variant="chip" color={colors.primaryDeep}>
          Delete sample
        </Txt>
      </Pressable>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    banner: {
      backgroundColor: c.primarySoft,
      borderRadius: radius.lg,
      paddingHorizontal: s(12),
      paddingVertical: s(10),
      marginHorizontal: s(16),
      marginBottom: s(8),
      gap: s(6),
    },
    // 48 dp of touch target, not the text's own height.
    action: { alignSelf: 'flex-start', minHeight: s(44), justifyContent: 'center' },
  });
}
