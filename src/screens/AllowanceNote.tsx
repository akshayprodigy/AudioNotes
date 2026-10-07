import React from 'react';
import { StyleSheet, View } from 'react-native';
import { SoftButton, Raised, Txt } from '../components/ui';
import { exhaustedCopy, statusLine } from '../billing/allowanceCopy';
import type { AllowanceStatus } from '../native/NativeLicence';
export { isExhausted } from '../billing/allowance';
import { radius, s, useTheme } from '../theme';

/**
 * The Free allowance, drawn the same way wherever it appears (Record, Library): a quiet line while
 * meetings are left, and a card with an upgrade button when none are.
 *
 * Neither is an alert. The allowance is a fact about the month, not a problem with the screen, and
 * Pro never sees either: [AllowanceLine] draws nothing for a paid phone.
 */

/** "3 of 5 free meetings left · resets 1 November." — nothing for Pro. */
export function AllowanceLine({ status }: { status: AllowanceStatus | null }) {
  const { colors } = useTheme();
  const line = statusLine(status);
  if (!line) return null;
  return (
    <Txt variant="chip" color={colors.inkDim} style={styles.line}>
      {line}
    </Txt>
  );
}

/**
 * The month's meetings are used up. Says so, says the saved meetings are still there, and offers
 * Pro. [resetsOn] is `YYYY-MM-DD`, from the ledger or from the refusal itself.
 */
export function AllowanceExhausted({ resetsOn, onUpgrade }: { resetsOn: string; onUpgrade: () => void }) {
  const { colors } = useTheme();
  return (
    <Raised edge={colors.line} fill={colors.card} rad={radius.lg} depth={4}>
      <View style={styles.card}>
        <Txt variant="chip" color={colors.ink}>
          {exhaustedCopy(resetsOn)}
        </Txt>
        <SoftButton icon="check" label="Get Pro" onPress={onUpgrade} />
      </View>
    </Raised>
  );
}

const styles = StyleSheet.create({
  line: { marginTop: s(4) },
  card: { padding: s(14), gap: s(10) },
});
