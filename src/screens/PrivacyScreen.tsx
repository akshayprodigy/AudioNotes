import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import Icon from '../components/Icon';
import { IconButton, Raised, SectionRule, Txt } from '../components/ui';
import { drops, events } from '../privacy/ledger';
import { crashConsent } from '../telemetry/crash';
import { formatBytes, summarise, type NetworkEvent } from '../privacy/summary';
import { radius, s, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Privacy'>;

const KIND_LABEL: Record<string, string> = {
  licence: 'Licence check',
  models: 'Setup download',
  crash: 'Crash report',
};

/**
 * What actually left this phone.
 *
 * The app tells people "nothing is uploaded" in six places. Every one of those is a promise the
 * reader cannot check, which is the shape of claim this project has already been bitten by — the
 * consent kit stamped meetings as announced on a media player's say-so, and was wrong four times
 * in six. This screen is the check: a count taken at the four call sites that own the app's
 * entire network access, shown with dates and hosts.
 *
 * It reports and never grades. There is no "you are private" and no green tick — the same
 * boundary the consent card holds, for the same reason.
 */
export default function PrivacyScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const [log, setLog] = useState<NetworkEvent[] | null>(null);
  const [unrecorded, setUnrecorded] = useState(0);
  const [showLog, setShowLog] = useState(false);
  // Whether crash reports are actually on. The "not counted" note about Crashlytics is only true
  // for somebody who turned them on, and a screen that lists a source you are not using is the
  // same kind of inaccuracy as one that hides a source you are.
  const [crashOn, setCrashOn] = useState(false);

  useEffect(() => {
    events()
      .then(setLog)
      .catch(() => setLog([]));
    drops()
      .then(setUnrecorded)
      .catch(() => setUnrecorded(0));
    crashConsent()
      .then(v => setCrashOn(v === 'on'))
      .catch(() => setCrashOn(false));
  }, []);

  const sum = useMemo(() => summarise(log ?? [], Date.now()), [log]);

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <Txt variant="display">What left this phone</Txt>
      </View>

      <ScrollView contentContainerStyle={st.body} showsVerticalScrollIndicator={false}>
        <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
          <View style={st.pad}>
            <Txt variant="metaBlack" color={colors.inkDim}>
              THIS MONTH
            </Txt>
            <Txt variant="display" style={st.big}>
              {sum.callsThisMonth === 0
                ? 'No network calls'
                : `${sum.callsThisMonth} network call${sum.callsThisMonth === 1 ? '' : 's'}`}
            </Txt>
            <Txt variant="body" color={colors.inkSoft}>
              {formatBytes(sum.sentThisMonth)} sent, {formatBytes(sum.receivedThisMonth)} received.
            </Txt>
            <Txt variant="display" style={st.big} color={colors.success}>
              {formatBytes(sum.audioBytes)} of audio
            </Txt>
            <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
              Audio, transcripts and minutes are never sent. Nothing in this app can put them on a
              network — that is why this reads zero, rather than a zero we typed in.
            </Txt>
          </View>
        </Raised>

        {sum.setupDownloadBytes > 0 ? (
          <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
            <View style={st.pad}>
              <Txt variant="metaBlack" color={colors.inkDim}>
                ONE-TIME SETUP
              </Txt>
              <Txt variant="bodyStrong" style={st.tiny}>
                {formatBytes(sum.setupDownloadBytes)} downloaded
              </Txt>
              <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                From {sum.setupHosts.join(', ')}. The speech and language models run on this phone,
                which is the reason nothing has to be uploaded to use it.
              </Txt>
            </View>
          </Raised>
        ) : null}

        {/* The exception, stated rather than buried. A privacy screen with something it quietly
            does not count is worth less than no screen at all. */}
        <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
          <View style={st.pad}>
            <Txt variant="metaBlack" color={colors.inkDim}>
              NOT COUNTED HERE
            </Txt>
            <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
              Google Play makes its own connection when you open the subscription screen. That one
              is Play's, not ours, and this app cannot see or count it.
            </Txt>
            {/* Crashlytics is uncountable by construction: reports are assembled and sent by
                Google Play Services, not by this app, so no hook in our code sees them. Naming it
                is the whole point — an uncounted source that is disclosed is honest, and one that
                is not is the overclaim this screen exists to prevent. Shown only when the person
                actually turned crash reports on, because for everyone else it is not true. */}
            {crashOn ? (
              <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                Crash reports go to Google Crashlytics, which sends them itself, so this app cannot
                count them. They carry a stack trace, the app version and the phone model — never
                your audio, transcripts or notes. Turn them off any time in Settings.
              </Txt>
            ) : null}
            <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
              Sent totals are request bodies. A request also carries a few hundred bytes of
              headers, which are not counted as data you sent.
            </Txt>
          </View>
        </Raised>

        {unrecorded > 0 ? (
          <Raised edge={colors.warning} fill={colors.card} rad={radius.xl} depth={5}>
            <View style={st.pad}>
              <Txt variant="bodyStrong" color={colors.warning}>
                {unrecorded} event{unrecorded === 1 ? '' : 's'} could not be recorded
              </Txt>
              <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                The database was unavailable when they happened, so the totals above are lower than
                what actually left. Said plainly rather than left to look like a smaller number.
              </Txt>
            </View>
          </Raised>
        ) : null}

        <View style={st.ruleWrap}>
          <SectionRule label="THE LOG" />
        </View>
        <Pressable
          onPress={() => setShowLog(v => !v)}
          accessibilityRole="button"
          accessibilityLabel={showLog ? 'Hide the log' : 'Show every recorded event'}>
          <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
            <View style={st.row}>
              <Txt variant="bodyStrong" style={st.flex}>
                {showLog ? 'Hide the log' : `Show all ${log?.length ?? 0} recorded events`}
              </Txt>
              <Icon
                name={showLog ? 'chevronUp' : 'chevronDown'}
                size={s(18)}
                color={colors.inkFaint}
                strokeWidth={2.4}
              />
            </View>
          </Raised>
        </Pressable>

        {showLog
          ? (log ?? []).map(e => (
              <Raised key={e.id} edge={colors.line} fill={colors.card} rad={radius.lg} depth={3}>
                <View style={st.pad}>
                  <Txt variant="bodyStrong">{KIND_LABEL[e.kind] ?? e.kind}</Txt>
                  <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                    {new Date(e.at).toLocaleString()} · {e.host}
                  </Txt>
                  <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                    {e.sent} bytes sent, {e.received} received{e.detail ? ` · ${e.detail}` : ''}
                  </Txt>
                </View>
              </Raised>
            ))
          : null}
      </ScrollView>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20) },
    body: { padding: s(20), gap: s(12) },
    pad: { padding: s(16) },
    row: { flexDirection: 'row', alignItems: 'center', padding: s(16), gap: s(12) },
    flex: { flex: 1 },
    big: { marginTop: s(6) },
    tiny: { marginTop: s(6) },
    ruleWrap: { marginTop: s(8) },
  });
}
