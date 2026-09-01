/**
 * Verbale — on-device meeting note-taker.
 * @format
 */
import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from './src/theme';
import RootNavigator from './src/navigation/RootNavigator';
import { db } from './src/db/queries';
import { refreshIfNeeded } from './src/billing/subscription';
import { initCrashReporting } from './src/telemetry/crash';

function App() {
  useEffect(() => {
    // Open the encrypted store on launch (no-op until the Storage native module is built).
    // Crash reporting waits on it, because consent is a setting and an unopened store is not
    // consent. It stays off entirely unless the store says otherwise and a DSN is configured.
    db.init()
      .then(() => initCrashReporting())
      .catch(() => {});

    // Renew the licence if it is near expiry. Opportunistic and silent: the token's remaining
    // life is exactly what covers a phone with no signal, so a refresh that cannot happen is not
    // worth interrupting anyone about. It only matters if it keeps failing until the token runs
    // out, and the Summary tab says so when it does.
    refreshIfNeeded().catch(() => {});
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
