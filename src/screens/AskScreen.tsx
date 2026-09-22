import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db, type Ask, type AskCite } from '../db/queries';
import Llm from '../native/NativeLlm';
import Icon from '../components/Icon';
import { IconButton, Raised, Txt } from '../components/ui';
import { provenanceLabel } from './meeting/ItemProvenance';
import { font, radius, s, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Ask'>;

/** What the thread says when the phone, not the meeting, could not answer. */
const REFUSAL_TEXT: Record<string, string> = {
  BUSY: 'The writer is busy with a meeting — try again in a minute.',
  NO_MODEL: 'Install the writer and the meaning index in Settings to ask.',
  NOT_CAPABLE: 'This phone does not have the memory to run the writer.',
};

/** One entry of the thread: an exchange, or a note about why there was none. */
type Entry = { kind: 'ask'; ask: Ask } | { kind: 'note'; id: string; question: string; text: string };

/**
 * Ask this meeting.
 *
 * A thread of questions and answers, oldest first; every answer cites the passages it came from,
 * and each citation is a way back to the moment in the transcript. An answer the model could
 * not ground is shown as the refusal phrase over the closest passages — still useful, never
 * invented. The writer is loaded on the first question and released when the screen is left,
 * so a person who asked one thing and went back does not hold 1.1 GB.
 *
 * Free users reach this screen; their first question opens the paywall, the way the summary's
 * "Write it" does. Nothing here decides who is Pro — native does, once, in Asker.gate.
 */
export default function AskScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { meetingId } = route.params;

  const [thread, setThread] = useState<Entry[]>([]);
  const [title, setTitle] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    let alive = true;
    db.asks(meetingId)
      .then(asks => alive && setThread(asks.map(ask => ({ kind: 'ask', ask }))))
      .catch(() => {});
    db.getMeeting(meetingId)
      .then(m => alive && m && setTitle(m.title))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [meetingId]);

  // The writer is the one heavy thing this screen holds. Give it back on the way out.
  useEffect(
    () => () => {
      Llm.unload().catch(() => {});
    },
    [],
  );

  const openMoment = useCallback(
    (c: AskCite) => navigation.navigate('Meeting', { meetingId, tab: 'transcript', atMs: c.startMs }),
    [navigation, meetingId],
  );

  const send = useCallback(async () => {
    const q = draft.trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      const r = await db.ask(meetingId, q);
      if (r.refusal === 'NOT_PRO') {
        navigation.navigate('Paywall', { meetingId });
      } else if (r.refusal) {
        setThread(t => [...t, { kind: 'note', id: `note-${Date.now()}`, question: q, text: REFUSAL_TEXT[r.refusal!] ?? r.refusal! }]);
        setDraft('');
      } else {
        setThread(t => [
          ...t,
          { kind: 'ask', ask: { id: r.id ?? `ask-${Date.now()}`, question: q, answer: r.answer, cites: r.cites, nothing: r.nothing, askedAt: Date.now() } },
        ]);
        setDraft('');
      }
    } catch (e: unknown) {
      setThread(t => [
        ...t,
        { kind: 'note', id: `note-${Date.now()}`, question: q, text: e instanceof Error ? e.message : String(e) },
      ]);
    } finally {
      setBusy(false);
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [draft, busy, meetingId, navigation]);

  return (
    // On Android the behaviour used to be left undefined, trusting the activity's adjustResize to
    // shrink the window. Under the edge-to-edge window an app targeting SDK 35 gets, it no longer
    // does: on the Pixel 9 emulator the keyboard covered the composer from y=1541 while the input
    // stayed at y=2248, so you typed your question blind. Same fix as the TextPrompt card in
    // components/ui.tsx — the padding behaviour listens to the keyboard itself, on either platform.
    <KeyboardAvoidingView
      style={[st.root, { paddingTop: insets.top + s(8) }]}
      behavior="padding">
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <View style={st.flex}>
          <Txt variant="sectionTitle" numberOfLines={1}>
            Ask this meeting
          </Txt>
          {title ? (
            <Txt variant="chipSoft" color={colors.inkFaint} numberOfLines={1}>
              {title}
            </Txt>
          ) : null}
        </View>
      </View>

      <ScrollView ref={scroll} contentContainerStyle={st.pad} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {thread.length === 0 ? (
          <View style={st.empty}>
            <Txt variant="body" color={colors.inkSoft} style={st.center}>
              Ask anything that was said here. Every answer points at the moment it came from.
            </Txt>
          </View>
        ) : null}
        {thread.map(e => (
          <View key={e.kind === 'ask' ? e.ask.id : e.id} style={st.exchange}>
            <View style={st.question}>
              <Txt variant="bodyStrong">{e.kind === 'ask' ? e.ask.question : e.question}</Txt>
            </View>
            <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={4} pressable={false}>
              <View style={st.answer}>
                {e.kind === 'note' ? (
                  <View style={st.noteRow}>
                    <Icon name="alert" size={s(16)} color={colors.warning} strokeWidth={2.4} />
                    <Txt variant="body" color={colors.inkSoft} style={st.flex}>
                      {e.text}
                    </Txt>
                  </View>
                ) : (
                  <>
                    <Txt variant="prose" color={e.ask.nothing ? colors.inkSoft : colors.ink}>
                      {e.ask.answer}
                    </Txt>
                    {e.ask.cites.length > 0 ? (
                      <>
                        {e.ask.nothing ? (
                          <Txt variant="overline" color={colors.inkFaint}>
                            Closest passages
                          </Txt>
                        ) : null}
                        <View style={st.cites}>
                          {e.ask.cites.map(c => (
                            <Cite key={`${e.ask.id}-${c.n}`} c={c} onOpen={openMoment} st={st} colors={colors} />
                          ))}
                        </View>
                      </>
                    ) : null}
                  </>
                )}
              </View>
            </Raised>
          </View>
        ))}
      </ScrollView>

      <View style={[st.composer, { paddingBottom: insets.bottom + s(12) }]}>
        <View style={[st.box, { backgroundColor: colors.card, borderColor: colors.line }]}>
          <TextInput
            style={st.input}
            placeholder="Ask this meeting…"
            placeholderTextColor={colors.inkFaint}
            value={draft}
            onChangeText={setDraft}
            editable={!busy}
            multiline
            returnKeyType="send"
            blurOnSubmit
            onSubmitEditing={send}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Ask"
            accessibilityState={{ disabled: busy || !draft.trim() }}
            disabled={busy || !draft.trim()}
            onPress={send}
            style={[st.send, { backgroundColor: busy || !draft.trim() ? colors.cardAlt : colors.primary }]}>
            <Txt variant="label" color={busy || !draft.trim() ? colors.inkFaint : '#FFFFFF'}>
              {busy ? 'Thinking…' : 'Ask'}
            </Txt>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

/** One citation: "[n] Speaker · m:ss", a way back to the moment. */
function Cite({
  c, onOpen, st, colors,
}: {
  c: AskCite; onOpen: (c: AskCite) => void; st: ReturnType<typeof makeStyles>; colors: Colors;
}) {
  const stamp = provenanceLabel(c.startMs);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Play [${c.n}] ${c.speaker} at ${stamp}`}
      onPress={() => onOpen(c)}
      style={({ pressed }) => [st.cite, { backgroundColor: colors.primarySoft, opacity: pressed ? 0.6 : 1 }]}>
      <Icon name="play" size={s(11)} color={colors.primary} strokeWidth={2.6} />
      <Txt variant="chipSm" color={colors.primary}>
        {`[${c.n}] ${c.speaker} · ${stamp}`}
      </Txt>
    </Pressable>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20), marginBottom: s(8) },
    pad: { paddingHorizontal: s(20), paddingVertical: s(12), gap: s(16) },
    empty: { paddingVertical: s(40), paddingHorizontal: s(16) },
    center: { textAlign: 'center' },
    exchange: { gap: s(8) },
    question: { alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: c.primarySoft, borderRadius: radius.lg, paddingHorizontal: s(14), paddingVertical: s(10) },
    answer: { padding: s(16), gap: s(10) },
    noteRow: { flexDirection: 'row', alignItems: 'center', gap: s(10) },
    cites: { flexDirection: 'row', flexWrap: 'wrap', gap: s(6) },
    cite: { flexDirection: 'row', alignItems: 'center', gap: s(5), paddingHorizontal: s(9), paddingVertical: s(5), borderRadius: s(8) },
    composer: { paddingHorizontal: s(16), paddingTop: s(8) },
    box: { flexDirection: 'row', alignItems: 'flex-end', gap: s(8), borderWidth: 1, borderRadius: radius.lg, paddingLeft: s(14), paddingRight: s(6), paddingVertical: s(6) },
    input: { flex: 1, color: c.ink, fontFamily: font.semibold, fontSize: s(15), maxHeight: s(110), paddingVertical: s(8) },
    send: { paddingHorizontal: s(14), paddingVertical: s(10), borderRadius: radius.md },
  });
}
