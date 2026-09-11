import React from 'react';
import { LayoutAnimation, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Icon from '../../components/Icon';
import { Raised, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Item, Minute, MinuteKind } from '../../pipeline/types';
import { db } from '../../db/queries';
import {
  Empty,
  EditedTag,
  MineTag,
  SectionHead,
  ToolButton,
  editTargetOf,
  editedText,
  isEdited,
  sentenceCase,
  splitAction,
  toItemRows,
  type EditMap,
  type ItemRow,
} from './shared';
import { ProvenanceButton } from './ItemProvenance';

/**
 * Re-exported, not reimplemented.
 *
 * This used to be a second copy of the hash, which — with the Kotlin mirror in ItemKey.kt — made
 * three. Every copy is a chance for a tick to silently detach from the item it belongs to, and
 * `edits` now hangs off the same key, so a drift would lose a person's correction as well as
 * their tick. The test imports it from here because that is where it first lived.
 *
 * The TICK no longer hangs off it for a row that is in `items` — see [ActionsTab] — but the EDIT
 * still does, for every row, until Task 11 moves the edits key onto item ids.
 */
export { itemKey } from './shared';

/** One row of the worklist. */
function Item({
  on,
  onToggle,
  colors,
  content,
  edited,
  mine,
  onEdit,
  onRevert,
  onRemove,
  provenance,
}: {
  on: boolean;
  onToggle: () => void;
  colors: Colors;
  /** What to show — the user's correction where there is one. Never what a key is computed on. */
  content: string;
  edited?: boolean;
  mine?: boolean;
  onEdit?: () => void;
  onRevert?: () => void;
  onRemove?: () => void;
  /** The way back to the moment it was said. Absent on a row that never claimed one. */
  provenance?: React.ReactNode;
}) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const { text, owner, due } = splitAction(content);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={text}
      accessibilityHint={onEdit ? 'Long press to correct this item' : undefined}
      accessibilityActions={onEdit ? [{ name: 'longpress', label: 'Correct this item' }] : undefined}
      onAccessibilityAction={e => {
        if (e.nativeEvent.actionName === 'longpress') onEdit?.();
      }}
      onLongPress={onEdit}
      onPress={onToggle}>
      <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={on ? 2 : 4}>
        <View style={st.check}>
          <View
            style={[
              st.box,
              { borderColor: on ? colors.success : colors.line },
              on && { backgroundColor: colors.success, borderColor: colors.success },
            ]}>
            {on ? <Icon name="check" size={s(14)} color="#FFFFFF" strokeWidth={3.4} /> : null}
          </View>
          <View style={st.flex}>
            <Txt
              variant="prose"
              color={on ? colors.inkFaint : colors.ink}
              style={on ? st.struck : null}>
              {sentenceCase(text)}
            </Txt>
            {/* One row, TWO rules, and the difference is the whole point of it.

                Owner and due date are fields the extractor mashed into the text. They are shown
                as what they are, only when there is something to say — most owners resolve to
                "Unassigned", which is not information — and only while the item is still work: a
                finished item is proof of work and these marks belong to working on it.

                The timestamp is not that, and putting it inside their `!on` gate emptied the Done
                section of every evidence link it had. Checking an item off is exactly when a
                reader wants to verify it, and the Done disclosure is what somebody returning to a
                list opens. It stays whether the box is ticked or not. */}
            {(!on && (owner || due)) || provenance ? (
              <View style={st.tags}>
                {!on && owner ? (
                  <View style={[st.tag, { backgroundColor: colors.primarySoft }]}>
                    <Icon name="users" size={s(11)} color={colors.primary} strokeWidth={2.6} />
                    <Txt variant="chipSm" color={colors.primary}>
                      {owner}
                    </Txt>
                  </View>
                ) : null}
                {!on && due ? (
                  <View style={[st.tag, { backgroundColor: colors.warningSoft }]}>
                    <Icon name="clock" size={s(11)} color={colors.warning} strokeWidth={2.6} />
                    <Txt variant="chipSm" color={colors.warning}>
                      {due}
                    </Txt>
                  </View>
                ) : null}
                {provenance}
              </View>
            ) : null}
            {/* Not shown on a ticked row, for the reason the chips above are not: these are marks
                of work in progress. Unlike the timestamp, which is a fact about the item. */}
            {!on && mine ? (
              <MineTag colors={colors} onRemove={onRemove} />
            ) : !on && edited ? (
              <EditedTag colors={colors} onRevert={onRevert} />
            ) : null}
          </View>
        </View>
      </Raised>
    </Pressable>
  );
}

/**
 * The worklist.
 *
 * Every item here came from rule extraction, so each one quotes something that was actually said —
 * measured invented=0 across four AMI fixtures. That is why the LLM's prose does not feed this tab:
 * on the same recording the rules found 7 actions with quotes and the model returned 2, with a
 * due-date field reading "After uploading the file".
 *
 * WHICH TICK STORE THIS IS, and the gap it closes. A row that is in `items` is ticked in
 * `item_done`, keyed on the item's id — the SAME store and the same key the cross-meeting worklist
 * writes (src/screens/actionsData.ts). Between Task 9 and this one they were different stores: a
 * tick made in the worklist did not show here and a tick made here did not show there. That gap
 * was accepted deliberately and this is the task that ends it.
 *
 * The text hash is NOT gone, because one population still has no item to key on: a row somebody
 * typed, and every row of a meeting whose migration has not run (see [toItemRows]). Those keep
 * `action_done` exactly as they always had it, which is what makes this an id-keyed tick for
 * everything that can have one rather than a migration that drops the ticks it cannot move. Task
 * 12 moves the typed rows across; nothing has to move the unmigrated ones, because opening the
 * meeting is what migrates them.
 *
 * `db.doneItems(meetingId)` rather than the library-wide `db.doneItemIds()`: this screen is one
 * meeting, and the wide read returns every tick in the library — a set that grows with the library
 * — flattened into `meetingId\u0000itemId` strings this tab would only have to take apart again to
 * ask about the meeting it is already looking at.
 */
export default function ActionsTab({
  meetingId,
  items,
  minutes,
  edits,
  onEditItem,
  onRevertItem,
  onRemoveItem,
  onAdd,
  onOpenProvenance,
  canPlay,
}: {
  meetingId: string;
  items: Item[];
  minutes: Minute[];
  edits?: EditMap;
  onEditItem?: (row: ItemRow) => void;
  /** Takes the ROW, not a key: where a correction lives is editTargetOf's answer, not a tab's. */
  onRevertItem?: (row: ItemRow) => void;
  /**
   * Takes the ROW for [onRevertItem]'s reason: a hand-typed row is an `items` row now and an
   * unmigrated meeting's is still a `minutes` row, so which table to delete from is the row's
   * own identity to answer and not a tab's. It was `(id: string)` while only one store held
   * these rows.
   */
  onRemoveItem?: (row: ItemRow) => void;
  onAdd?: (kind: MinuteKind) => void;
  /** Open the transcript at a moment, and play from it where there is still audio to play. */
  onOpenProvenance?: (ms: number) => void;
  /** False once the recording has been discarded. The links stay; only playback goes. */
  canPlay?: boolean;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const [doneIds, setDoneIds] = React.useState<Set<string>>(new Set());
  const [doneTexts, setDoneTexts] = React.useState<Set<string>>(new Set());
  const [showDone, setShowDone] = React.useState(false);
  // Memoised, unlike the plain `edits ?? new Map()` this used to be. Every callback below closes
  // over it, so a fresh Map on each render rebuilt all of them on each render — and the lint rule
  // that says so was previously silenced rather than answered.
  const ed = React.useMemo<EditMap>(() => edits ?? new Map(), [edits]);

  const rows = React.useMemo(() => toItemRows(items, minutes), [items, minutes]);

  React.useEffect(() => {
    let alive = true;
    // Both stores, because both populations are on this screen. They cannot collide on a row that
    // has an item id — that row is never looked up by text — so the only way a tick lands on the
    // wrong row is a TYPED row whose wording is character-for-character an extracted row that was
    // ticked before this meeting was migrated. It shows as ticked; it is one hash, it is the same
    // sentence, and the population it can happen to is now only a meeting nobody has migrated.
    Promise.all([db.doneItems(meetingId), db.doneActions(meetingId)])
      .then(([ids, texts]) => {
        if (!alive) return;
        setDoneIds(ids);
        setDoneTexts(texts);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [meetingId]);

  /** Ticked, asked of whichever store this row's identity lives in. */
  const isDone = React.useCallback(
    (r: ItemRow) => (r.itemId ? doneIds.has(r.itemId) : doneTexts.has(r.textKey)),
    [doneIds, doneTexts],
  );

  /**
   * Tick or untick.
   *
   * Optimistic, exactly as the cross-meeting worklist is: the tick belongs on the next frame, not
   * after a database round trip, and a failed write costs a tick rather than the item. `on` is
   * computed OUTSIDE the state updater so the write happens once — a React updater is allowed to
   * run twice, and the second run would issue a second write.
   */
  const toggle = React.useCallback(
    (r: ItemRow) => {
      const on = !isDone(r);
      // A ticked item leaves the list for the Done section. Without an animation it teleports.
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      const flip = (prev: Set<string>, key: string) => {
        const next = new Set(prev);
        if (on) next.add(key);
        else next.delete(key);
        return next;
      };
      if (r.itemId) {
        const id = r.itemId;
        setDoneIds(prev => flip(prev, id));
        db.setItemDone(meetingId, id, on).catch(() => {});
      } else {
        const key = r.textKey;
        setDoneTexts(prev => flip(prev, key));
        db.setActionDone(meetingId, key, on).catch(() => {});
      }
    },
    [isDone, meetingId],
  );

  /** The text to display: the correction where there is one, the stored text otherwise. */
  const shown = React.useCallback(
    (r: ItemRow) => {
      const t = editTargetOf(r);
      return editedText(ed, t.kind, t.key, r.text) ?? r.text;
    },
    [ed],
  );

  /** The way back to the moment. Nothing for a row that never claimed to have been said. */
  const provenanceFor = React.useCallback(
    (r: ItemRow) =>
      onOpenProvenance && r.anchorStartMs !== null ? (
        <ProvenanceButton
          anchorStartMs={r.anchorStartMs}
          onOpen={onOpenProvenance}
          canPlay={canPlay ?? false}
        />
      ) : undefined,
    [onOpenProvenance, canPlay],
  );

  /**
   * One row, wired for correction.
   *
   * The correction is never keyed on what is DISPLAYED — that is the whole reason edits live in a
   * side table. It is keyed on the row's identity: its item id where it has one, and the hash of
   * its stored text where it does not. See editTargetOf.
   */
  const row = React.useCallback(
    (r: ItemRow, on: boolean) => {
      const t = editTargetOf(r);
      return (
      <Item
        key={r.key}
        on={on}
        onToggle={() => toggle(r)}
        colors={colors}
        content={shown(r)}
        edited={isEdited(ed, t.kind, t.key)}
        mine={r.mine}
        onEdit={onEditItem ? () => onEditItem(r) : undefined}
        onRevert={onRevertItem ? () => onRevertItem(r) : undefined}
        // `r.mine` and nothing else. The old gate also asked for `r.minuteId`, which a hand-typed
        // row stopped having the moment Task 12 moved it into `items` — leaving it would have
        // taken the remove button off every row that has ever had one, silently.
        onRemove={onRemoveItem && r.mine ? () => onRemoveItem(r) : undefined}
        provenance={provenanceFor(r)}
      />
      );
    },
    [ed, colors, onEditItem, onRevertItem, onRemoveItem, provenanceFor, shown, toggle],
  );

  const actions = rows.filter(r => r.kind === 'action');
  const decisions = rows.filter(r => r.kind === 'decision');
  const questions = rows.filter(r => r.kind === 'question');

  const nothing = actions.length === 0 && decisions.length === 0 && questions.length === 0;
  const todo = actions.filter(r => !isDone(r));
  const finished = actions.filter(r => isDone(r));
  const pct = actions.length ? finished.length / actions.length : 0;

  /** A decision or an open question: read-only, and still checkable against the recording. */
  const plain = (r: ItemRow, tone: string) => (
    <Raised key={r.key} edge={colors.line} fill={colors.card} rad={radius.xl} depth={4}>
      <View style={st.plain}>
        <View style={[st.rule, { backgroundColor: tone }]} />
        <View style={st.flex}>
          <Txt variant="prose">{sentenceCase(splitAction(shown(r)).text)}</Txt>
          {provenanceFor(r)}
        </View>
      </View>
    </Raised>
  );

  return (
    <ScrollView contentContainerStyle={st.pad} showsVerticalScrollIndicator={false}>
      {nothing ? <Empty text="Nothing to act on came out of this meeting." colors={colors} /> : null}

      {/* Above the list, not below it: the model missing an action is exactly the case where the
          list is short or empty, and a control at the foot of an empty list is a control nobody
          finds. */}
      {onAdd ? (
        <View style={st.addRow}>
          <ToolButton
            icon="plus"
            label="Add an action"
            hint="Add something somebody owes that the app did not pick up"
            colors={colors}
            onPress={() => onAdd('action')}
          />
        </View>
      ) : null}

      {actions.length > 0 ? (
        <>
          {/* Progress, because a worklist of twenty-nine is a job you come back to and the one
              thing you want on arrival is how far in you already are. */}
          <View style={st.progressRow}>
            <Txt variant="bodyStrong" color={colors.ink}>
              {finished.length} of {actions.length} done
            </Txt>
            <View style={st.track}>
              <View
                style={[st.fill, { width: `${Math.round(pct * 100)}%`, backgroundColor: colors.success }]}
              />
            </View>
          </View>

          {todo.length > 0 ? (
            <View style={st.list}>{todo.map(r => row(r, false))}</View>
          ) : (
            <Empty text="Everything here is done." colors={colors} />
          )}

          {/* Finished items are kept but folded away: they are the proof of work, not the work. */}
          {finished.length > 0 ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showDone }}
                onPress={() => {
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setShowDone(v => !v);
                }}>
                <View style={st.foldRow}>
                  <Txt variant="overlineSm" color={colors.inkFaint}>
                    DONE · {finished.length}
                  </Txt>
                  <Icon
                    name={showDone ? 'chevronUp' : 'chevronDown'}
                    size={s(16)}
                    color={colors.inkFaint}
                    strokeWidth={2.8}
                  />
                </View>
              </Pressable>
              {showDone ? (
                <View style={st.list}>{finished.map(r => row(r, true))}</View>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {decisions.length > 0 ? (
        <>
          <SectionHead label="DECIDED" count={decisions.length} colors={colors} style={st.heading} />
          <View style={st.list}>{decisions.map(r => plain(r, colors.primary))}</View>
        </>
      ) : null}

      {questions.length > 0 ? (
        <>
          <SectionHead
            label="STILL OPEN"
            count={questions.length}
            colors={colors}
            style={st.heading}
          />
          <View style={st.list}>{questions.map(r => plain(r, colors.success))}</View>
        </>
      ) : null}
    </ScrollView>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    pad: { paddingHorizontal: s(16), paddingBottom: s(30), gap: s(12) },
    list: { gap: s(10) },
    heading: { marginTop: s(10) },
    addRow: { flexDirection: 'row', paddingHorizontal: s(2), paddingTop: s(2) },
    flex: { flex: 1 },
    progressRow: { gap: s(8), paddingHorizontal: s(2) },
    track: { height: s(6), borderRadius: s(3), backgroundColor: c.cardAlt, overflow: 'hidden' },
    fill: { height: '100%', borderRadius: s(3) },
    check: { flexDirection: 'row', gap: s(12), padding: s(14), alignItems: 'flex-start' },
    box: {
      width: s(23),
      height: s(23),
      borderRadius: s(7),
      borderWidth: s(2),
      alignItems: 'center',
      justifyContent: 'center',
      // Optical centring against the first line of prose rather than the top of its box.
      marginTop: s(2),
    },
    struck: { textDecorationLine: 'line-through' },
    tags: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: s(6), marginTop: s(8) },
    tag: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(4),
      paddingHorizontal: s(8),
      paddingVertical: s(4),
      borderRadius: s(8),
    },
    foldRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: s(8),
      marginTop: s(4),
    },
    plain: { flexDirection: 'row', gap: s(12), padding: s(14), alignItems: 'stretch' },
    rule: { width: s(3), borderRadius: s(2) },
  });
}
