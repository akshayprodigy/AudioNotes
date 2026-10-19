import React, { useCallback, useEffect, useState } from 'react';
import { DeviceEventEmitter, StatusBar, View } from 'react-native';
import { DefaultTheme, NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { font, useTheme } from '../theme';
import { db } from '../db/queries';
import AudioPipeline from '../native/NativeAudioPipeline';
import Mascot from '../components/Mascot';
import OnboardingScreen from '../screens/OnboardingScreen';
import RecordScreen from '../screens/RecordScreen';
import LibraryScreen from '../screens/LibraryScreen';
import MeetingScreen from '../screens/MeetingScreen';
import SpeakersScreen from '../screens/SpeakersScreen';
import SearchScreen from '../screens/SearchScreen';
import SettingsScreen from '../screens/SettingsScreen';
import ArchiveScreen from '../screens/ArchiveScreen';
import NoticesScreen from '../screens/NoticesScreen';
import VocabularyScreen from '../screens/VocabularyScreen';
import ActionsScreen from '../screens/ActionsScreen';
import FollowUpScreen from '../screens/FollowUpScreen';
import PaywallScreen from '../screens/PaywallScreen';
import ConsentCardScreen from '../screens/ConsentCardScreen';
import PrivacyScreen from '../screens/PrivacyScreen';
import ReviewScreen from '../screens/ReviewScreen';
import AskScreen from '../screens/AskScreen';
import ThreadScreen from '../screens/ThreadScreen';
import SharePreviewScreen from '../share/SharePreviewScreen';

export type RootStackParamList = {
  Onboarding: undefined;
  Library: undefined;
  Record: undefined;
  /**
   * `tab` and `atMs` let something outside the screen say where to land: a search hit opens the
   * transcript at the moment the phrase was said, a "Notes ready" tap opens the summary.
   */
  Meeting: {
    meetingId: string;
    tab?: MeetingTab;
    atMs?: number;
    /**
     * With `atMs`: also PLAY from that moment, once, when the recording still has audio. Set by the
     * places that hand over a moment the person asked to hear — an Ask citation, a thread or
     * worklist row — and never by a search hit, which only scrolls (see MeetingScreen).
     */
    play?: boolean;
    fromNotification?: boolean;
  };
  Speakers: { meetingId: string };
  /** The review queue for one meeting: what the classifier could not settle, one card at a time. */
  Review: { meetingId: string };
  /** Ask this meeting: a thread of answers that cite the transcript (sub-project 5). */
  Ask: { meetingId: string };
  /** A thread: the meetings sharing one tag, Pro only (Phase 3, decision history + preparation). */
  Thread: { tag: string };
  Search: undefined;
  Settings: undefined;
  Archive: undefined;
  Notices: undefined;
  /** Phase 5: the correction rules, Pro (Settings › Vocabulary). */
  Vocabulary: undefined;
  /** The card held up to the room. No params: it says the same thing for every meeting. */
  ConsentCard: undefined;
  /** What is about to be shared, as it will be sent, with the format picker and the Share button. */
  Share: { meetingId: string };
  /** What actually left the phone. No params: it is the whole ledger or nothing. */
  Privacy: undefined;
  Actions: undefined;
  /** The follow-up home's filtered lists (Pro): due actions, open decisions, notes to review. */
  FollowUp: { kind: 'due' | 'decisions' | 'review' };
  /** `meetingId` is the meeting that prompted the sell, so the screen can name it. */
  Paywall: { meetingId?: string; from?: 'onboarding' | 'export' } | undefined;
};

export type MeetingTab = 'summary' | 'mom' | 'transcript' | 'actions';

const Stack = createNativeStackNavigator<RootStackParamList>();

// A container-level ref so a native "Notes ready" tap can navigate without a screen in scope.
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

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

  // Both callers here are the "Your notes are ready" notification — cold start below, warm tap in
  // the effect after it. The screen is told so, because that notification promises the notes and
  // must deliver them, not the once-ever Pro sheet (see MeetingScreen's offer effect).
  const openMeeting = useCallback((meetingId?: string | null) => {
    if (meetingId && navigationRef.isReady()) {
      navigationRef.navigate('Meeting', { meetingId, fromNotification: true });
    }
  }, []);

  // Warm tap: the app is already running, so MainActivity.onNewIntent emits onOpenMeeting.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('onOpenMeeting', (e: { meetingId?: string }) =>
      openMeeting(e?.meetingId),
    );
    return () => sub.remove();
  }, [openMeeting]);

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
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={colors.canvas}
      />
      <NavigationContainer
        ref={navigationRef}
        theme={navTheme}
        onReady={() => {
          // Cold start: MainActivity stashed the id before React existed; consume it once the
          // navigator is mounted so navigate() has somewhere to go.
          AudioPipeline.consumePendingMeetingId().then(openMeeting).catch(() => {});
        }}>
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
          <Stack.Screen name="Notices" component={NoticesScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Vocabulary" component={VocabularyScreen} options={{ headerShown: false }} />
          <Stack.Screen
            name="ConsentCard"
            component={ConsentCardScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Privacy"
            component={PrivacyScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen name="Actions" component={ActionsScreen} options={{ headerShown: false }} />
          <Stack.Screen name="FollowUp" component={FollowUpScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Review" component={ReviewScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Ask" component={AskScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Thread" component={ThreadScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Share" component={SharePreviewScreen} options={{ headerShown: false }} />
          <Stack.Screen
            name="Paywall"
            component={PaywallScreen}
            options={{ headerShown: false, presentation: 'modal' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </>
  );
}