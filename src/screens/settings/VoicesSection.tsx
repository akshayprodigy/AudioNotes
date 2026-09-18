import React from 'react';
import { Alert, View, StyleSheet } from 'react-native';
import Icon from '../../components/Icon';
import { Raised, SectionRule, SoftButton, Switch, Txt } from '../../components/ui';
import { radius, s, useTheme } from '../../theme';

/**
 * Settings › Voices (Phase 4). Pure: reads its state from props, reports changes up. Paid shows
 * the switch; free shows "(Pro)" and the row opens the paywall. "Forget all voices" is shown to
 * both — a lapsed user can still delete. Copy is the brief's §2.9, verbatim.
 */
export default function VoicesSection({
  paid,
  remember,
  onToggle,
  onForget,
  onUpgrade,
}: {
  paid: boolean;
  remember: boolean;
  onToggle: (next: boolean) => void;
  onForget: () => void;
  onUpgrade: () => void;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(), []);
  const confirmForget = () =>
    Alert.alert(
      'Forget all voices?',
      'This deletes every stored voiceprint on this phone. Names already given to speakers stay.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Forget', style: 'destructive', onPress: onForget },
      ],
    );
  return (
    <>
      <View style={st.ruleWrap}>
        <SectionRule label="VOICES" />
      </View>
      <View style={st.list}>
        <Raised
          edge={colors.line}
          fill={colors.card}
          rad={radius.xl}
          depth={5}
          onPress={paid ? undefined : onUpgrade}>
          <View style={st.rowPad}>
            <View style={st.row}>
              <Icon name="users" size={s(18)} color={colors.inkSoft} strokeWidth={2.4} />
              <View style={st.flex}>
                <Txt variant="bodyStrong">{paid ? 'Remember voices' : 'Remember voices (Pro)'}</Txt>
                <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                  When you name a speaker, Verbale keeps a small numeric voiceprint of that voice on
                  this phone and uses it to suggest the name next time. Nothing is uploaded and nothing leaves the phone. A voiceprint is personal data — in
                  some places biometric data — so turn this on only if you are comfortable holding it, and tell the
                  people you record where the law or your workplace requires it. "Forget all voices" deletes every
                  voiceprint at any time.
                </Txt>
              </View>
              {paid ? <Switch on={remember} onToggle={() => onToggle(!remember)} /> : null}
            </View>
            <View style={st.forget}>
              <SoftButton icon="trash" label="Forget all voices" onPress={confirmForget} />
            </View>
          </View>
        </Raised>
      </View>
    </>
  );
}

function makeStyles() {
  return StyleSheet.create({
    ruleWrap: { marginHorizontal: s(20), marginTop: s(22), marginBottom: s(10) },
    list: { paddingHorizontal: s(20), gap: s(10) },
    rowPad: { padding: s(16) },
    row: { flexDirection: 'row', alignItems: 'center', gap: s(12) },
    flex: { flex: 1, gap: s(4) },
    tiny: { lineHeight: s(17) },
    forget: { alignItems: 'flex-start' },
  });
}
