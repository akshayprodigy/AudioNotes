import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Icon from '../components/Icon';
import { ProgressBar, Raised, Txt } from '../components/ui';
import { downloadLabel, downloadPct } from '../screens/downloadLabel';
import { radius, s, useTheme } from '../theme';
import { runProModels, useProModelsStore } from './proModels';

/**
 * Pro's background download, on the Library: how far it has got and that it carries on while the
 * app is in use, or, when it stopped, why, with Try again. This is the way back from a failed
 * download, so nobody needs Settings for it. Nothing at all is drawn otherwise.
 */
export default function ProModelsCard() {
  const { colors } = useTheme();
  const { running, error, downloaded, total } = useProModelsStore();
  if (!error && !(running && total > 0)) return null;
  const tone = error ? colors.warning : colors.primary;

  return (
    <View style={st.wrap} testID="pro-models-card">
      <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
        <View style={st.body}>
          <View style={st.head}>
            <Icon name={error ? 'alert' : 'download'} size={s(20)} color={tone} strokeWidth={2.4} />
            <Txt variant="bodyStrong" style={st.flex}>
              {error ? "Pro's models did not finish downloading" : "Downloading Pro's models"}
            </Txt>
          </View>
          {error ? (
            <>
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
            </>
          ) : (
            <>
              <ProgressBar pct={downloadPct(downloaded, total)} color={tone} track={colors.cardAlt} />
              <Txt variant="chip" color={colors.inkFaint}>
                {`${downloadLabel(downloaded, total)} · it carries on while you use the app.`}
              </Txt>
            </>
          )}
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
