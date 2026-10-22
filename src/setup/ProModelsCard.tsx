import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Icon from '../components/Icon';
import { Raised, Txt } from '../components/ui';
import { radius, s, useTheme } from '../theme';
import { runProModels, useProModelsStore } from './proModels';

/**
 * Pro's background download when it stopped, on the Library: why, with Try again. This is the way
 * back from a failed download, so nobody needs Settings for it. Nothing at all is drawn otherwise
 * (progress shows in the downloads strip).
 */
export default function ProModelsCard() {
  const { colors } = useTheme();
  const { error } = useProModelsStore();
  if (!error) return null;

  return (
    <View style={st.wrap} testID="pro-models-card">
      <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
        <View style={st.body}>
          <View style={st.head}>
            <Icon name="alert" size={s(20)} color={colors.warning} strokeWidth={2.4} />
            <Txt variant="bodyStrong" style={st.flex}>
              Pro's models did not finish downloading
            </Txt>
          </View>
          <Txt variant="chip" color={colors.warning}>
            {error}
          </Txt>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            onPress={() => {
              runProModels().catch(() => {});
            }}
            style={st.action}>
            <Txt variant="cta" color={colors.primary}>
              Try again
            </Txt>
          </Pressable>
        </View>
      </Raised>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { marginHorizontal: s(20), marginTop: s(12) },
  body: { padding: s(14), gap: s(10) },
  head: { flexDirection: 'row', alignItems: 'center', gap: s(10) },
  flex: { flex: 1 },
  action: { minHeight: s(44), justifyContent: 'center', alignSelf: 'flex-start' },
});
