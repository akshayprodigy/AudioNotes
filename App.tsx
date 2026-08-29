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

function App() {
  useEffect(() => {
    // Open the encrypted store on launch (no-op until the Storage native module is built).
    db.init().catch(() => {});

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
