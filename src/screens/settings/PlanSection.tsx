import React from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { Button, Raised, SoftButton, Txt } from '../../components/ui';
import { formatReset, settingsValue } from '../../billing/allowanceCopy';
import type { AllowanceStatus, LicenceStatus } from '../../native/NativeLicence';
import { radius, s, useTheme } from '../../theme';

/** `YYYY-MM-DD` of a unix-seconds instant, in local time, for formatReset. */
function localDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Settings › Plan & account. One calm card: what the plan is, and the few things that follow from
 * it. Pro sees nothing that sells Pro. A Play free trial looks like a paid period on the phone, so
 * this never says "trial".
 */
export default function PlanSection({
  lic,
  allowance,
  hasServer,
  playCan,
  playBusy,
  signedInAs,
  onManage,
  onRestorePurchase,
  onSignOut,
  onSeePlans,
  emailSignIn,
}: {
  lic: LicenceStatus | null;
  allowance: AllowanceStatus | null;
  hasServer: boolean;
  playCan: boolean;
  playBusy: boolean;
  signedInAs: string | null;
  onManage: () => void;
  onRestorePurchase: () => void;
  onSignOut: () => void;
  onSeePlans: () => void;
  emailSignIn: React.ReactNode;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(), []);
  const [showEmailSignIn, setShowEmailSignIn] = React.useState(false);
  const paid = !!lic?.paid;
  const allowanceLine = settingsValue(allowance);

  const link = (label: string, onPress: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      style={st.link}>
      <Txt variant="chip" color={disabled ? colors.inkFaint : colors.inkSoft}>
        {label}
      </Txt>
    </Pressable>
  );

  let body: React.ReactNode;
  if (!hasServer) {
    body = (
      <Txt variant="chip" color={colors.inkFaint} style={st.tiny}>
        This build has no licence server configured.
      </Txt>
    );
  } else if (paid) {
    const until = lic && lic.expiresAt > 0 ? formatReset(localDate(lic.expiresAt)) : '';
    body = (
      <>
        {until ? (
          <>
            <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
              {`Active through ${until}`}
            </Txt>
            <Txt variant="chip" color={colors.inkFaint} style={st.tiny}>
              Renews in Google Play unless you cancel.
            </Txt>
          </>
        ) : (
          <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
            Everything in Pro is on.
          </Txt>
        )}
        {playCan ? (
          <View style={st.gap}>
            <SoftButton icon="settings" label="Manage in Google Play" onPress={onManage} />
          </View>
        ) : null}
        {signedInAs ? link('Sign out', onSignOut) : null}
      </>
    );
  } else {
    body = (
      <>
        {allowanceLine ? (
          <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
            {allowanceLine}
          </Txt>
        ) : null}
        {lic?.state === 'expired' && lic.lapsedCopy ? (
          <Txt variant="chip" color={colors.inkFaint} style={st.tiny}>
            {lic.lapsedCopy}
          </Txt>
        ) : null}
        {playCan ? (
          <>
            <View style={st.gap}>
              <Button icon="check" label="See Pro plans" onPress={onSeePlans} full />
            </View>
            <View style={st.linkRow}>
              {link('Restore a purchase', onRestorePurchase, playBusy)}
              {showEmailSignIn ? null : link('I already have an account', () => setShowEmailSignIn(true))}
            </View>
            {/* Secondary, and phrased as a statement of fact rather than an invitation.
                Honouring a subscription bought elsewhere is permitted; steering somebody
                there is not, so this offers no price, no link and no way to buy. */}
            {showEmailSignIn ? (
              <>
                <Txt variant="chip" color={colors.inkFaint} style={st.tiny}>
                  For an account that already has a subscription.
                </Txt>
                {emailSignIn}
              </>
            ) : null}
          </>
        ) : signedInAs ? (
          link('Sign out', onSignOut)
        ) : (
          emailSignIn
        )}
      </>
    );
  }

  return (
    <View style={st.list}>
      <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
        <View style={st.rowPad}>
          <Txt variant="overlineSm" color={colors.inkFaint}>
            CURRENT PLAN
          </Txt>
          <Txt variant="display" style={st.tiny}>
            {paid ? 'Pro' : 'Free'}
          </Txt>
          {body}
        </View>
      </Raised>
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    list: { paddingHorizontal: s(20), gap: s(10) },
    rowPad: { padding: s(16) },
    tiny: { marginTop: s(4) },
    gap: { marginTop: s(12) },
    linkRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: s(16), marginTop: s(4) },
    link: { minHeight: s(44), alignItems: 'center', justifyContent: 'center', paddingHorizontal: s(4) },
  });
