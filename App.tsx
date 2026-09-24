/**
 * Verbale — on-device meeting note-taker.
 * @format
 */
import React, { useEffect } from 'react';
import { AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from './src/theme';
import RootNavigator from './src/navigation/RootNavigator';
import { db } from './src/db/queries';
import { syncEntitlement } from './src/billing/subscription';
import { initCrashReporting } from './src/telemetry/crash';

function App() {
  useEffect(() => {
    // Open the encrypted store on launch (no-op until the Storage native module is built).
    // Crash reporting waits on it, because consent is a setting and an unopened store is not
    // consent. It stays off entirely unless the store says otherwise and a DSN is configured.
    db.init()
      .then(() => initCrashReporting())
      .catch(() => {});

    // Pro follows the buyer, not the last cold start: renew a licence near expiry, and pick up a
    // purchase the app never heard back about (offline at purchase, a slow payment, a reinstall).
    // Checked again on every return to the app, where most of those resolve.
    syncEntitlement().catch(() => {});
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') syncEntitlement().catch(() => {});
    });
    return () => sub.remove();
  }, []);

  return (
    <ThemeProvider>
      <SafeAreaProvider>
        <RootNavigator />
      </SafeAreaProvider>
    </ThemeProvider>
  );
}

export default App;
