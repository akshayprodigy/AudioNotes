import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, NativeEventEmitter, NativeModules, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import FileExport from '../native/NativeFileExport';
import Player from '../native/NativePlayer';
import { Button, IconButton, Segmented, Switch, Txt } from '../components/ui';
import { radius, s, text as textStyle, useTheme, type Colors } from '../theme';
import {
  AUDIO_DELETED_MESSAGE,
  carriesAttribution,
  MP3,
  MP3_HINT,
  MP3_LABEL,
  SHARE_FORMATS,
  type ShareChoice,
  type ShareFormat,
} from './formats';
import { loadAttribution, saveAttribution } from './attribution';
import { ATTRIBUTION, segmentLine } from './markers';

type Props = NativeStackScreenProps<RootStackParamList, 'Share'>;

/**
 * Look at what is about to leave the phone, then send it.
 *
 * THE PREVIEW IS THE FILE. The text on this screen comes from `FileExport.preview`, which is the
 * same native path `FileExport.shareWith` renders from (`ShareDocument` builds one document;
 * Markdown, text, PDF and this preview are all written from it). Nothing here describes the
 * document in JavaScript, so the preview cannot say something the file does not.
 *
 * WHO MAY SHARE IS NOT DECIDED HERE. Every file export is Pro, and the gate is in the native module
 * (ExportGate.kt) so a bug in a screen cannot hand a file to a Free user. This screen opens for
 * everybody and shows the preview — seeing what you would get is the point — and when the module
 * refuses with PRO_REQUIRED it sends the person to the Pro sheet. It reads a rejection code and
 * nothing else: nothing in `src/share/` imports from `src/billing/`, and `ShareAvailability.test.tsx`
 * keeps it that way.
 *
 * MP3 is the other thing offered here: the original recording, not a document. It has no preview and
 * no credit line, and it is disabled — with the reason — once the recording has been deleted.
 *
 * What the meeting did not settle is written into the document in words ("Owner not set", "No
 * date given", "Needs a look") and drawn apart here. Nothing is ever filled in to look complete.
 */
export default function SharePreviewScreen({ navigation, route }: Props) {
  const { meetingId } = route.params;
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const st = useMemo(() => makeStyles(colors), [colors]);

  const [choice, setChoice] = useState<ShareChoice>('pdf');
  const isMp3 = choice === MP3;
  // The document formats only: the preview and the credit line are not defined for a recording.
  const format: ShareFormat = choice === MP3 ? 'pdf' : choice;
  // null until the file has been looked for. The MP3 row waits for a yes; it is never offered on a guess.
  const [hasAudio, setHasAudio] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [attribution, setAttribution] = useState(false);
  const [remembered, setRemembered] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const seq = useRef(0);

  // The saved choice first, so the first preview already has it and the toggle never flips under
  // a finger.
  useEffect(() => {
    let alive = true;
    loadAttribution().then(on => {
      if (!alive) return;
      setAttribution(on);
      setRemembered(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const stamped = attribution && carriesAttribution(choice);

  useEffect(() => {
    let alive = true;
    Player.hasAudio(meetingId)
      .then(has => alive && setHasAudio(has))
      .catch(() => alive && setHasAudio(false));
    return () => {
      alive = false;
    };
  }, [meetingId]);

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.FileExport);
    const sub = emitter.addListener('onMp3Progress', (e: { fraction: number }) => setProgress(e.fraction));
    return () => sub.remove();
  }, []);

  // A recording needs no preview. The effect still runs when the screen opens on a document.
  useEffect(() => {
    if (!remembered || isMp3) return;
    const mine = ++seq.current;
    setShown(null);
    setFailed(false);
    FileExport.preview(meetingId, format, stamped)
      .then(t => {
        if (mine === seq.current) setShown(t);
      })
      .catch(() => {
        if (mine === seq.current) setFailed(true);
      });
  }, [meetingId, format, stamped, remembered, isMp3]);

  const onToggle = useCallback(() => {
    const next = !attribution;
    setAttribution(next);
    saveAttribution(next);
  }, [attribution]);

  const onShare = useCallback(async () => {
    setSharing(true);
    try {
      if (isMp3) {
        setProgress(0);
        await FileExport.exportMp3(meetingId);
      } else {
        await FileExport.shareWith(meetingId, format, stamped);
      }
    } catch (e: any) {
      if (e?.code === 'PRO_REQUIRED') {
        // The native gate said no: this is a Pro feature. Show the Pro sheet, not an error.
        navigation.navigate('Paywall', { meetingId, from: 'export' });
      } else if (e?.code === 'AUDIO_DELETED') {
        setHasAudio(false);
      } else if (e?.code !== 'cancelled') {
        Alert.alert('Could not share', String(e?.message ?? e));
      }
    } finally {
      setSharing(false);
      setProgress(null);
    }
  }, [meetingId, format, stamped, isMp3, navigation]);

  const onCancel = useCallback(() => {
    FileExport.cancelMp3().catch(() => {});
  }, []);

  const lines = useMemo(() => (shown === null ? [] : shown.split('\n')), [shown]);
  const hasOpen = useMemo(
    () => lines.some(l => segmentLine(l, format === 'pdf').some(g => g.kind === 'unresolved')),
    [lines, format],
  );
  const hint = isMp3 ? MP3_HINT : (SHARE_FORMATS.find(f => f.key === format)?.hint ?? '');
  const ready = isMp3 ? hasAudio === true : shown !== null || failed;

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8), paddingBottom: insets.bottom + s(12) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <View style={st.flex}>
          <Txt variant="sectionTitle">Share</Txt>
          <Txt variant="chipSoft" color={colors.inkSoft}>
            This is exactly what will be sent.
          </Txt>
        </View>
      </View>

      <View style={st.pad}>
        <Segmented
          items={SHARE_FORMATS.map(f => ({ key: f.key, label: f.label }))}
          value={choice}
          onChange={k => setChoice(k as ShareFormat)}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={MP3_LABEL}
          accessibilityState={{ selected: isMp3, disabled: hasAudio !== true }}
          disabled={hasAudio !== true}
          onPress={() => setChoice(MP3)}
          style={[st.mp3, isMp3 && st.mp3On, hasAudio !== true && st.mp3Off]}>
          <Txt variant={isMp3 ? 'chip' : 'chipSoft'} color={isMp3 ? colors.primaryDeep : colors.inkDim}>
            {MP3_LABEL}
          </Txt>
        </Pressable>
        {hasAudio === false ? (
          <Txt variant="chipSoft" color={colors.warningDeep}>
            {AUDIO_DELETED_MESSAGE}
          </Txt>
        ) : null}
        <Txt variant="chipSoft" color={colors.inkSoft}>
          {hint}
        </Txt>
      </View>

      <ScrollView
        style={st.previewWrap}
        contentContainerStyle={st.preview}
        showsVerticalScrollIndicator
        accessibilityLabel="Preview of what will be shared">
        {isMp3 ? (
          <Txt variant="body" color={colors.inkSoft}>
            This sends the recording itself, as an MP3 — what was said, not the minutes.
          </Txt>
        ) : failed ? (
          <Txt variant="body" color={colors.inkSoft}>
            The preview could not be made. You can still share.
          </Txt>
        ) : shown === null ? (
          <Txt variant="body" color={colors.inkSoft}>
            Preparing the preview…
          </Txt>
        ) : (
          lines.map((line, i) => (
            <PreviewLine key={i} line={line} pdf={format === 'pdf'} colors={colors} />
          ))
        )}
      </ScrollView>

      {hasOpen ? (
        <View style={st.legend}>
          <Txt variant="chipSoft" color={colors.warningDeep}>
            Orange notes are what the meeting did not settle. Nothing is filled in for you.
          </Txt>
        </View>
      ) : null}

      <View style={st.pad}>
        <View style={st.attr}>
          {/* The words toggle it too: a 48 dp switch is a small target for a label that big. The
              switch stays the one control a screen reader announces, so this row is not a second. */}
          <Pressable
            style={st.flex}
            accessible={false}
            disabled={!carriesAttribution(choice)}
            onPress={onToggle}
            testID="credit-label">
            <Txt variant="sub">Add a small credit at the bottom</Txt>
            <Txt variant="chipSoft" color={colors.inkSoft}>
              {carriesAttribution(choice)
                ? `“${ATTRIBUTION}”, once, after everything else.`
                : isMp3
                  ? 'A recording never carries it.'
                  : 'Subtitle files never carry it.'}
            </Txt>
          </Pressable>
          {carriesAttribution(choice) ? <Switch on={attribution} onToggle={onToggle} /> : null}
        </View>
        {isMp3 && progress !== null ? (
          <>
            <Txt variant="chipSoft" color={colors.inkSoft}>
              {`Making the MP3… ${Math.round(progress * 100)}%`}
            </Txt>
            <Button label="Cancel" full onPress={onCancel} />
          </>
        ) : (
          <Button label="Share" icon="share" full disabled={sharing || !ready} onPress={onShare} />
        )}
      </View>
    </View>
  );
}

function PreviewLine({ line, pdf, colors }: { line: string; pdf: boolean; colors: Colors }) {
  const heading = !pdf && /^#{1,2}\s/.test(line);
  const segs = segmentLine(line, pdf);
  const base = textStyle(heading ? 'bodyStrong' : 'transcript', colors.ink);
  return (
    <Text testID="share-preview-line" style={[base, line === '' && { lineHeight: s(10) }]}>
      {segs.map((g, i) => {
        if (g.kind === 'plain') return g.text;
        const style =
          g.kind === 'unresolved'
            ? { color: colors.warningDeep, backgroundColor: colors.warningSoft, fontFamily: textStyle('chip').fontFamily }
            : g.kind === 'done'
              ? { color: colors.inkFaint }
              : { color: colors.inkFaint, fontSize: s(12) };
        return (
          <Text key={i} testID={`share-flag-${g.kind}`} style={style}>
            {g.text}
          </Text>
        );
      })}
    </Text>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20), marginBottom: s(12) },
    pad: { paddingHorizontal: s(20), gap: s(10), marginBottom: s(10) },
    previewWrap: {
      flex: 1,
      marginHorizontal: s(20),
      marginBottom: s(8),
      backgroundColor: c.card,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.line,
    },
    preview: { padding: s(14), gap: s(2) },
    legend: { paddingHorizontal: s(20), marginBottom: s(8) },
    attr: { flexDirection: 'row', alignItems: 'center', gap: s(12) },
    mp3: {
      alignItems: 'center',
      paddingVertical: s(10),
      borderRadius: radius.ctl,
      borderWidth: 1,
      borderColor: c.line,
      backgroundColor: c.cardAlt,
    },
    mp3On: { backgroundColor: c.card },
    mp3Off: { opacity: 0.5 },
  });
}
