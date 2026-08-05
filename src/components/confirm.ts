import { Alert } from 'react-native';

/**
 * Confirm an irreversible action.
 *
 * A platform Alert on purpose. The in-app Sheet is the right shape for *choosing* an action, but
 * the last step before destroying something should look like the operating system asking, not
 * like more of the app — it is the one moment where app furniture working against muscle memory
 * is a feature.
 *
 * The message must say what will be lost in concrete terms. "Are you sure?" tells the user
 * nothing they did not already know; "the transcript and minutes go too, and this cannot be
 * undone" is the sentence that stops the wrong tap.
 */
export function confirmDestructive(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}): void {
  Alert.alert(opts.title, opts.message, [
    { text: 'Cancel', style: 'cancel' },
    { text: opts.confirmLabel, style: 'destructive', onPress: opts.onConfirm },
  ]);
}

/** "Team sync" -> `“Team sync”`, with a fallback for a meeting that never got a title. */
export function quoted(title: string | undefined | null): string {
  const t = (title ?? '').trim();
  return t ? `“${t}”` : 'this meeting';
}
