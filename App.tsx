/**
 * AudioNotes — on-device meeting note-taker.
 * @format
 */
import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from './src/theme';
import RootNavigator from './src/navigation/RootNavigator';
import { db } from './src/db/queries';

function App() {
  useEffect(() => {
    // Open the encrypted store on launch (no-op until the Storage native module is built).
    db.init().catch(() => {});
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
