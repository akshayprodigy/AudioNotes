import React, { useEffect, useState } from 'react';
import { StatusBar, View } from 'react-native';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { font, useTheme } from '../theme';
import { db } from '../db/queries';
import Mascot from '../components/Mascot';
import OnboardingScreen from '../screens/OnboardingScreen';
import RecordScreen from '../screens/RecordScreen';
import LibraryScreen from '../screens/LibraryScreen';
import MeetingScreen from '../screens/MeetingScreen';
import SpeakersScreen from '../screens/SpeakersScreen';
import SearchScreen from '../screens/SearchScreen';
import SettingsScreen from '../screens/SettingsScreen';
import ArchiveScreen from '../screens/ArchiveScreen';

export type RootStackParamList = {
  Onboarding: undefined;
  Library: undefined;
  Record: undefined;
  Meeting: { meetingId: string };
  Speakers: { meetingId: string };
  Search: undefined;
  Settings: undefined;
  Archive: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
  const { colors } = useTheme();
  const [initial, setInitial] = useState<keyof RootStackParamList | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const onboarded = await db.getSetting('onboarded');
        setInitial(onboarded === '1' ? 'Library' : 'Onboarding');
      } catch {
        setInitial('Library');
      }
    })();
  }, []);

  const navTheme = {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      background: colors.canvas,
      card: colors.canvas,
      text: colors.ink,
      border: colors.line,
      primary: colors.primary,
    },
  };

  const screenOptions = {
    // Headers sit on the canvas, not on a separate white bar: the screens already carry their own
    // padding and cards, and a contrasting header strip cuts the page in two for no benefit.
    headerStyle: { backgroundColor: colors.canvas },
    headerTintColor: colors.ink,
    headerTitleStyle: { fontFamily: font.bold, fontSize: 17, color: colors.ink },
    headerShadowVisible: false,
    headerBackButtonDisplayMode: 'minimal' as const,
    contentStyle: { backgroundColor: colors.canvas },
  };

  // Brief gate while we read the onboarding flag. Showing the mascot rather than a spinner keeps
  // the very first frame on-brand instead of a bare grey wheel.
  if (!initial) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.canvas, alignItems: 'center', justifyContent: 'center' }}>
        <Mascot mood="idle" size={110} />
      </View>
    );
  }

  // The PiP window's contents are drawn NATIVELY (see MainActivity + PipContentView.kt): React
  // Native can't render into the Android PiP surface because react-native-screens' native-stack
  // screen owns the captured window and draws above any RN view. So the navigator here is just the
  // normal full-screen app; nothing PiP-specific lives on the JS side.
  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor={colors.canvas} />
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator initialRouteName={initial} screenOptions={screenOptions}>
          <Stack.Screen
            name="Onboarding"
            component={OnboardingScreen}
            options={{ headerShown: false }}
          />
          {/* Library, Record and Meeting each draw their own header — a large title, a status
              bar, a meeting name — so the stack header would only duplicate them. They handle
              their own safe-area inset accordingly. */}
          <Stack.Screen name="Library" component={LibraryScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Record" component={RecordScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Meeting" component={MeetingScreen} options={{ headerShown: false }} />
          {/* Every screen draws its own header — a back chip plus a title, matching the design —
              so the stack header is off everywhere and each screen owns its safe-area inset. */}
          <Stack.Screen name="Speakers" component={SpeakersScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Search" component={SearchScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Archive" component={ArchiveScreen} options={{ headerShown: false }} />
        </Stack.Navigator>
      </NavigationContainer>
    </>
  );
}