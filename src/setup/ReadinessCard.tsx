import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Icon from '../components/Icon';
import { ProgressBar, Raised, Txt } from '../components/ui';
import { spaceFits, spaceReason } from '../screens/deviceFit';
import { radius, s, useTheme, type Colors } from '../theme';
import { readinessCopy } from './readiness';
import type { Setup } from './useReadiness';

/**
 * "Finish setup — 60% of 114 MB downloaded", with the one thing to do about it.
 *
 * Shown on the Library and Record screens whenever the essential models are not all on the phone:
 * after "Later, from Settings", after a failed or interrupted download, after the app was killed
 * mid-way. It is the way back from every one of those, so first run never ends in a dead end.
 * Nothing at all is drawn once the phone is ready, or while the catalog has not answered.
 *
 * Device fit is not re-derived here: the phone that cannot run the engines gets no card (onboarding
 * says why), and a download the disk cannot hold says so in the same sentence the onboarding and
 * Settings screens use, in place of the button.
 */
export default function ReadinessCard({ setup }: { setup: Setup }) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const { state, fit } = setup;
  const copy = readinessCopy(state);
  if (!copy || state.state === 'ready' || state.state === 'unknown') return null;
  if (fit?.cpuReason) return null;

  const short =
    fit && state.pendingBytes > 0 && !spaceFits(state.pendingBytes, fit.freeBytes)
      ? spaceReason('the speech models', state.pendingBytes, fit.freeBytes)
      : null;
  const failed = state.state === 'failed';
  const tone = failed ? colors.warning : colors.primary;

  return (
    <View style={st.wrap} accessibilityLabel={copy.title}>
      <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
        <View style={st.body}>
          <View style={st.head}>
            <Icon name={failed ? 'alert' : 'download'} size={s(20)} color={tone} strokeWidth={2.4} />
            <Txt variant="bodyStrong" style={st.flex}>
              {copy.title}
            </Txt>
          </View>
          {state.state !== 'notStarted' ? (
            <ProgressBar pct={state.pct} color={tone} track={colors.cardAlt} />
          ) : null}
          {short ? (
            <Txt variant="chip" color={colors.warning}>
              {short}
            </Txt>
          ) : copy.action ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${copy.action} setup`}
              onPress={() => {
                setup.start().then(setup.reload).catch(() => {});
              }}
              style={st.action}>
              <Txt variant="cta" color={colors.primary}>
                {copy.action}
              </Txt>
            </Pressable>
          ) : (
            <Txt variant="chip" color={colors.inkFaint}>
              It carries on if you leave this screen.
            </Txt>
          )}
        </View>
      </Raised>
    </View>
  );
}

function makeStyles(_c: Colors) {
  return StyleSheet.create({
    wrap: { marginHorizontal: s(20), marginTop: s(12) },
    body: { padding: s(14), gap: s(10) },
    head: { flexDirection: 'row', alignItems: 'center', gap: s(10) },
    flex: { flex: 1 },
    // A full 44 dp row: this is the one action a stuck first run has.
    action: { minHeight: s(44), justifyContent: 'center', alignSelf: 'flex-start' },
  });
}
