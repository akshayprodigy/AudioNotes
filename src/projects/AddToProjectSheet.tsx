import React, { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Icon, { type IconName } from '../components/Icon';
import { Button, SoftButton, Txt, type SheetAction } from '../components/ui';
import { entitlement } from '../billing/trial';
import { db, normaliseTag } from '../db/queries';
import { radius, s, useTheme, type Colors } from '../theme';
import {
  PROJECT_EXPLAINER,
  PROJECT_FREE_NOTE,
  PROJECT_PRO_LINE,
  projectChoices,
  resolveTyped,
  type ProjectChoice,
} from './projects';

/** The menu entry, spelled once so the Library's long-press and the Meeting's overflow say the same. */
export const ADD_TO_PROJECT: { icon: IconName; label: string; hint: string } = {
  icon: 'plus',
  label: 'Add to project',
  hint: 'Group this meeting with others so you can see their decisions and open actions together.',
};

/**
 * A bottom sheet that puts one meeting into a project (Pro): pick one that exists or name a new one.
 *
 * Over the existing tag/thread system and nothing else: a project is a tag, "creating" one is
 * applying a tag no meeting has yet (`db.addTag`), and the thread view that makes it useful is the
 * Pro screen it already was. Free sees why instead of a button that does nothing: "Projects are
 * part of Pro" and the way to upgrade; their tags keep working as they always have.
 */
export default function AddToProjectSheet({
  visible,
  meetingId,
  meetingTitle,
  onClose,
  onChanged,
  onUpgrade,
}: {
  visible: boolean;
  meetingId: string;
  meetingTitle?: string;
  onClose: () => void;
  /** Called after the tag is written, so the caller can re-read its own tag list. */
  onChanged?: (project: string) => void;
  onUpgrade: () => void;
}) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const { height } = useWindowDimensions();
  // null until entitlement has answered: a Pro user must not see the upsell flash first.
  const [paid, setPaid] = useState<boolean | null>(null);
  const [choices, setChoices] = useState<ProjectChoice[]>([]);
  const [typed, setTyped] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setTyped('');
    setFailed(false);
    setBusy(false);
    setPaid(null);
    (async () => {
      const ent = await entitlement().catch(() => ({ paid: false }));
      if (!alive) return;
      if (!ent.paid) {
        setPaid(false);
        return;
      }
      const [all, mine] = await Promise.all([
        Promise.resolve(db.allTags()).catch(() => []),
        Promise.resolve(db.tagsFor(meetingId)).catch(() => [] as string[]),
      ]);
      if (!alive) return;
      setChoices(projectChoices(all ?? [], mine ?? []));
      setPaid(true);
    })();
    return () => {
      alive = false;
    };
  }, [visible, meetingId]);

  const typedPlan = resolveTyped(typed, choices, n => normaliseTag(n) || '');

  const apply = async (name: string) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await db.addTag(meetingId, name);
    } catch {
      // Stay open with the words kept: a failed write must not throw away what was typed.
      setBusy(false);
      setFailed(true);
      return;
    }
    setBusy(false);
    onChanged?.(name);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={st.backdrop} onPress={onClose} accessibilityLabel="Dismiss">
        <View style={[st.scrim, { backgroundColor: colors.scrim }]} />
      </Pressable>
      {/* Padding behaviour, not adjustResize: a Modal is its own window and edge-to-edge kills resize. */}
      <KeyboardAvoidingView style={st.wrap} behavior="padding" pointerEvents="box-none">
        <View style={[st.card, { backgroundColor: colors.card, maxHeight: height * 0.85 }]}>
          <View style={[st.grip, { backgroundColor: colors.line }]} />
          <Txt variant="sectionTitle">Add to project</Txt>
          {meetingTitle ? (
            <Txt variant="chipSoft" color={colors.inkFaint} numberOfLines={1} style={st.sub}>
              {meetingTitle}
            </Txt>
          ) : null}
          <Txt variant="body" color={colors.inkSoft} style={st.explain}>
            {PROJECT_EXPLAINER}
          </Txt>

          {paid === false ? (
            <View style={st.body}>
              <View style={[st.proBox, { backgroundColor: colors.primarySoft }]}>
                <Icon name="lock" size={s(18)} color={colors.primaryDeep} strokeWidth={2.4} />
                <Txt variant="bodyStrong" color={colors.primaryDeep} style={st.flex}>
                  {PROJECT_PRO_LINE}
                </Txt>
              </View>
              <Txt variant="chipSoft" color={colors.inkSoft} style={st.note}>
                {PROJECT_FREE_NOTE}
              </Txt>
              <Button
                label="Upgrade to Pro"
                full
                onPress={() => {
                  onClose();
                  onUpgrade();
                }}
              />
              <View style={st.row}>
                <SoftButton label="Not now" onPress={onClose} />
              </View>
            </View>
          ) : null}

          {paid === true ? (
            <View style={st.body}>
              <Txt variant="overlineSm" color={colors.inkFaint} style={st.label}>
                YOUR PROJECTS
              </Txt>
              {choices.length === 0 ? (
                <Txt variant="chipSoft" color={colors.inkSoft}>
                  No projects yet. Name the first one below.
                </Txt>
              ) : (
                <ScrollView style={st.list} showsVerticalScrollIndicator persistentScrollbar>
                  {choices.map(c => (
                    <Pressable
                      key={c.name}
                      accessibilityRole="button"
                      accessibilityLabel={c.applied ? `${c.name}, this meeting is already in it` : `Add to ${c.name}`}
                      accessibilityState={{ disabled: c.applied, selected: c.applied }}
                      disabled={c.applied || busy}
                      onPress={() => apply(c.name)}
                      style={({ pressed }) => [st.choice, { backgroundColor: pressed ? colors.cardAlt : 'transparent' }]}>
                      <View style={st.flex}>
                        <Txt variant="bodyStrong">{c.name}</Txt>
                        <Txt variant="chipSoft" color={colors.inkFaint}>
                          {`${c.meetings} meeting${c.meetings === 1 ? '' : 's'}`}
                        </Txt>
                      </View>
                      {c.applied ? <Icon name="check" size={s(18)} color={colors.success} strokeWidth={3} /> : null}
                    </Pressable>
                  ))}
                </ScrollView>
              )}

              <Txt variant="overlineSm" color={colors.inkFaint} style={st.label}>
                OR START A NEW ONE
              </Txt>
              <TextInput
                value={typed}
                onChangeText={setTyped}
                placeholder="Project name"
                accessibilityLabel="Project name"
                placeholderTextColor={colors.inkFaint}
                maxLength={32}
                returnKeyType="done"
                onSubmitEditing={() => typedPlan && apply(typedPlan.name)}
                style={[st.input, { borderColor: colors.line, color: colors.ink, backgroundColor: colors.cardAlt }]}
              />
              {failed ? (
                <Txt variant="chipSoft" color={colors.danger} style={st.note}>
                  Could not save that. Try again.
                </Txt>
              ) : null}
              <View style={st.row}>
                <SoftButton label="Cancel" onPress={onClose} />
                <SoftButton
                  label={
                    typedPlan
                      ? typedPlan.exists
                        ? `Add to “${typedPlan.name}”`
                        : `Create “${typedPlan.name}”`
                      : 'Create project'
                  }
                  icon="plus"
                  disabled={!typedPlan || busy}
                  onPress={() => typedPlan && apply(typedPlan.name)}
                />
              </View>
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * The single hook the Meeting screen needs: its overflow entry and the sheet it opens.
 *
 *   const project = useAddToProject(meetingId, { onUpgrade, onChanged });
 *   sheetActions: [..., project.action, ...]        // beside "Add a tag"
 *   render:       {project.sheet}                    // anywhere in the screen's tree
 */
export function useAddToProject(
  meetingId: string,
  opts: { meetingTitle?: string; onUpgrade: () => void; onChanged?: (project: string) => void },
): { action: SheetAction; sheet: React.ReactElement; open: () => void } {
  const [open, setOpen] = useState(false);
  return {
    action: { ...ADD_TO_PROJECT, onPress: () => setOpen(true) },
    open: () => setOpen(true),
    sheet: (
      <AddToProjectSheet
        visible={open}
        meetingId={meetingId}
        meetingTitle={opts.meetingTitle}
        onClose={() => setOpen(false)}
        onChanged={opts.onChanged}
        onUpgrade={opts.onUpgrade}
      />
    ),
  };
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    scrim: { flex: 1, opacity: 0.38 },
    wrap: { flex: 1, justifyContent: 'flex-end' },
    card: {
      borderTopLeftRadius: radius.sheet,
      borderTopRightRadius: radius.sheet,
      paddingHorizontal: s(20),
      paddingTop: s(10),
      paddingBottom: s(28),
    },
    grip: { alignSelf: 'center', width: s(42), height: s(5), borderRadius: 999, marginBottom: s(14) },
    sub: { marginTop: s(2) },
    explain: { marginTop: s(8) },
    body: { marginTop: s(14), gap: s(8) },
    label: { marginTop: s(6) },
    list: { maxHeight: s(220) },
    choice: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingVertical: s(10), paddingHorizontal: s(8), borderRadius: radius.lg },
    input: { borderWidth: 1, borderRadius: s(12), paddingHorizontal: s(12), paddingVertical: s(10) },
    note: { marginTop: s(2) },
    proBox: { flexDirection: 'row', alignItems: 'center', gap: s(10), padding: s(12), borderRadius: radius.lg },
    row: { flexDirection: 'row', gap: s(10), marginTop: s(8) },
  });
}
