import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, StatusBar } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { db } from '../db/queries';
import OnboardingScreen from '../screens/OnboardingScreen';
import RecordScreen from '../screens/RecordScreen';
import LibraryScreen from '../screens/LibraryScreen';
import MeetingScreen from '../screens/MeetingScreen';
import SpeakersScreen from '../screens/SpeakersScreen';
import SearchScreen from '../screens/SearchScreen';
import SettingsScreen from '../screens/SettingsScreen';

export type RootStackParamList = {
  Onboarding: undefined;
  Library: undefined;
  Record: undefined;
  Meeting: { meetingId: string };
  Speakers: { meetingId: string };
  Search: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
  const { colors, isDark } = useTheme();
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
    ...(isDark ? DarkTheme : DefaultTheme),
    colors: {
      ...(isDark ? DarkTheme : DefaultTheme).colors,
      background: colors.bg,
      card: colors.surface,
      text: colors.text,
      border: colors.border,
      primary: colors.primary,
    },
  };

  const screenOptions = {
    headerStyle: { backgroundColor: colors.surface },
    headerTintColor: colors.text,
    headerTitleStyle: { fontWeight: '700' as const },
    headerShadowVisible: false,
    contentStyle: { backgroundColor: colors.bg },
  };

  if (!initial) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.surface} />
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator initialRouteName={initial} screenOptions={screenOptions}>
          <Stack.Screen name="Onboarding" component={OnboardingScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Library" component={LibraryScreen} options={{ title: 'AudioNotes' }} />
          <Stack.Screen name="Record" component={RecordScreen} options={{ title: 'Record' }} />
          <Stack.Screen name="Meeting" component={MeetingScreen} options={{ title: 'Meeting' }} />
          <Stack.Screen name="Speakers" component={SpeakersScreen} options={{ title: 'Speakers' }} />
          <Stack.Screen name="Search" component={SearchScreen} options={{ title: 'Search' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </>
  );
}
