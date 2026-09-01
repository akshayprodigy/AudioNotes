/**
 * The email/password form, in one place.
 *
 * It is needed on two screens for different reasons — in Settings because that is where an account
 * is managed, and on the paywall because that is the only screen that explains Pro, and somebody
 * who had already bought it on the website had no way there to say so. Two copies of a sign-in
 * form is two places for a validation rule or an error message to drift apart.
 *
 * The screen-specific half stays with the screen: this component signs in, reports what happened,
 * and does nothing else. Settings uses that to record the address and refresh its licence row; the
 * paywall uses it to close itself.
 */
import React, { useState } from 'react';
import { Alert, TextInput, View } from 'react-native';

import { SoftButton } from '../components/ui';
import { s, useTheme } from '../theme';
import { signIn, type SignInResult } from './subscription';

export default function SignInForm({
  onSignedIn,
}: {
  onSignedIn?: (result: SignInResult) => void | Promise<void>;
}) {
  const { colors } = useTheme();
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await signIn(email.trim(), pass);
      setPass('');
      await onSignedIn?.(res);
      // Silent on success: the screen behind this reflects the new state by itself. The one case
      // worth a sentence is the confusing one — correct credentials, no subscription — where
      // saying nothing would leave someone hunting for what went wrong.
      if (!res.paid) {
        Alert.alert(
          'Signed in',
          'This account does not have a subscription yet. Everything except the written summary ' +
            'keeps working.',
        );
      }
    } catch (e: any) {
      Alert.alert('Could not sign in', String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const field = {
    borderWidth: 1,
    borderColor: colors.line,
    color: colors.ink,
    borderRadius: s(10),
    paddingHorizontal: s(14),
    paddingVertical: s(12),
    fontSize: s(16),
    marginTop: s(8),
  } as const;

  return (
    <View>
      <TextInput
        style={field}
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        placeholderTextColor={colors.inkFaint}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={field}
        value={pass}
        onChangeText={setPass}
        placeholder="Password"
        placeholderTextColor={colors.inkFaint}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <SoftButton
        icon="lock"
        label={busy ? 'Signing in…' : 'Sign in'}
        onPress={submit}
        disabled={busy || !email || !pass}
      />
    </View>
  );
}
