import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import FileExport from '../native/NativeFileExport';
import { Button, IconButton, Segmented, Switch, Txt } from '../components/ui';
import { radius, s, text as textStyle, useTheme, type Colors } from '../theme';
import { carriesAttribution, SHARE_FORMATS, type ShareFormat } from './formats';
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
 * WHAT IT DOES NOT DEPEND ON: a licence, a plan, the Free allowance. Sharing and every format are
 * free for everyone, always — including when the monthly allowance is spent and when Pro has
 * lapsed. Nothing in `src/share/` imports from `src/billing/`, and `ShareAvailability.test.tsx`
 * keeps it that way.
 *
 * What the meeting did not settle is written into the document in words ("Owner not set", "No
 * date given", "Needs a look") and drawn apart here. Nothing is ever filled in to look complete.
 */
export default function SharePreviewScreen({ navigation, route }: Props) {
  const { meetingId } = route.params;
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const st = useMemo(() => makeStyles(colors), [colors]);

  const [format, setFormat] = useState<ShareFormat>('pdf');
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

  const stamped = attribution && carriesAttribution(format);

  useEffect(() => {
    if (!remembered) return;
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
  }, [meetingId, format, stamped, remembered]);

  const onToggle = useCallback(() => {
    const next = !attribution;
    setAttribution(next);
    saveAttribution(next);
  }, [attribution]);

  const onShare = useCallback(async () => {
    setSharing(true);
    try {
      await FileExport.shareWith(meetingId, format, stamped);
    } catch (e: any) {
      Alert.alert('Could not share', String(e?.message ?? e));
    } finally {
      setSharing(false);
    }
  }, [meetingId, format, stamped]);

  const lines = useMemo(() => (shown === null ? [] : shown.split('\n')), [shown]);
  const hasOpen = useMemo(
    () => lines.some(l => segmentLine(l, format === 'pdf').some(g => g.kind === 'unresolved')),
    [lines, format],
  );
  const hint = SHARE_FORMATS.find(f => f.key === format)?.hint ?? '';
  const ready = shown !== null || failed;

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
          value={format}
          onChange={k => setFormat(k as ShareFormat)}
        />
        <Txt variant="chipSoft" color={colors.inkSoft}>
          {hint}
        </Txt>
      </View>

      <ScrollView
        style={st.previewWrap}
        contentContainerStyle={st.preview}
        showsVerticalScrollIndicator
        accessibilityLabel="Preview of what will be shared">
        {failed ? (
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
          <View style={st.flex}>
            <Txt variant="sub">Add a small credit at the bottom</Txt>
            <Txt variant="chipSoft" color={colors.inkSoft}>
              {carriesAttribution(format)
                ? `“${ATTRIBUTION}”, once, after everything else.`
                : 'Subtitle files never carry it.'}
            </Txt>
          </View>
          {carriesAttribution(format) ? <Switch on={attribution} onToggle={onToggle} /> : null}
        </View>
        <Button label="Share" icon="share" full disabled={sharing || !ready} onPress={onShare} />
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
  });
}
