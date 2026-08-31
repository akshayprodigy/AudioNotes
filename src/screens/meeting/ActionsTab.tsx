import React from 'react';
import { LayoutAnimation, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Icon from '../../components/Icon';
import { Raised, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Minute, MinuteKind } from '../../pipeline/types';
import { db } from '../../db/queries';
import {
  Empty,
  EditedTag,
  MineTag,
  SectionHead,
  ToolButton,
  editedText,
  isEdited,
  itemKey,
  minuteText,
  sentenceCase,
  splitAction,
  type EditMap,
} from './shared';

/**
 * Re-exported, not reimplemented.
 *
 * This used to be a second copy of the hash, which — with the Kotlin mirror in ItemKey.kt — made
 * three. Every copy is a chance for a tick to silently detach from the item it belongs to, and
 * `edits` now hangs off the same key, so a drift would lose a person's correction as well as
 * their tick. The test imports it from here because that is where it first lived.
 */
export { itemKey } from './shared';

/** One row of the worklist. */
function Item({
  m,
  on,
  onToggle,
  colors,
  content,
  edited,
  mine,
  onEdit,
  onRevert,
  onRemove,
}: {
  m: Minute;
  on: boolean;
  onToggle: () => void;
  colors: Colors;
  /** What to show — the user's correction where there is one. Never what the tick is keyed on. */
  content?: string;
  edited?: boolean;
  mine?: boolean;
  onEdit?: () => void;
  onRevert?: () => void;
  onRemove?: () => void;
}) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const { text, owner, due } = splitAction(content ?? minuteText(m));
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
            {/* Owner and due date are fields the extractor mashed into the text. Shown as what
                they are, and shown at all only when there is something to say — most owners
                resolve to "Unassigned", which is not information. */}
            {(owner || due) && !on ? (
              <View style={st.tags}>
                {owner ? (
                  <View style={[st.tag, { backgroundColor: colors.primarySoft }]}>
                    <Icon name="users" size={s(11)} color={colors.primary} strokeWidth={2.6} />
                    <Txt variant="chipSm" color={colors.primary}>
                      {owner}
                    </Txt>
                  </View>
                ) : null}
                {due ? (
                  <View style={[st.tag, { backgroundColor: colors.warningSoft }]}>
                    <Icon name="clock" size={s(11)} color={colors.warning} strokeWidth={2.6} />
                    <Txt variant="chipSm" color={colors.warning}>
                      {due}
                    </Txt>
                  </View>
                ) : null}
              </View>
            ) : null}
            {/* Not shown on a ticked row: a finished item is proof of work, and the marks belong
                to working on it. */}
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
 */
export default function ActionsTab({
  meetingId,
  minutes,
  edits,
  onEditItem,
  onRevertItem,
  onRemoveItem,
  onAdd,
}: {
  meetingId: string;
  minutes: Minute[];
  edits?: EditMap;
  onEditItem?: (m: Minute) => void;
  onRevertItem?: (key: string) => void;
  onRemoveItem?: (id: string) => void;
  onAdd?: (kind: MinuteKind) => void;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const [done, setDone] = React.useState<Set<string>>(new Set());
  const [showDone, setShowDone] = React.useState(false);
  const ed: EditMap = edits ?? new Map();

  /**
   * One row, wired for correction.
   *
   * The tick key comes from the STORED text and never from the correction. That is the whole
   * reason edits live in a side table: rewriting a minute in place would change its hash and
   * silently untick it, so fixing a typo in an item you had already done would undo it.
   */
  const row = React.useCallback(
    (m: Minute, on: boolean, fallbackKey: string) => {
      // itemKey(m.content), not itemKey(displayed): the tick above and the export renderer in
      // Kotlin both hash the stored column, and three keys for one item is how a correction goes
      // missing from the document somebody sends out.
      const key = itemKey(m.content);
      return (
        <Item
          key={m.id ?? fallbackKey}
          m={m}
          on={on}
          onToggle={() => toggle(m.content)}
          colors={colors}
          content={editedText(ed, 'minute', key, minuteText(m))}
          edited={isEdited(ed, 'minute', key)}
          mine={m.source === 'user'}
          onEdit={onEditItem ? () => onEditItem(m) : undefined}
          onRevert={onRevertItem ? () => onRevertItem(key) : undefined}
          onRemove={
            onRemoveItem && m.source === 'user' && m.id ? () => onRemoveItem(m.id) : undefined
          }
        />
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ed, colors, onEditItem, onRevertItem, onRemoveItem],
  );

  React.useEffect(() => {
    let alive = true;
    db.doneActions(meetingId)
      .then(d => {
        if (alive) setDone(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [meetingId]);

  const actions = minutes.filter(m => m.kind === 'action');
  const decisions = minutes.filter(m => m.kind === 'decision');
  const questions = minutes.filter(m => m.kind === 'question');

  const toggle = React.useCallback(
    (content: string) => {
      const key = itemKey(content);
      // A ticked item leaves the list for the Done section. Without an animation it teleports.
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setDone(prev => {
        const next = new Set(prev);
        const on = !next.has(key);
        if (on) next.add(key);
        else next.delete(key);
        // Optimistic: the tick should land on the next frame, not after a database round trip.
        // A failed write costs a tick, not the item.
        db.setActionDone(meetingId, key, on).catch(() => {});
        return next;
      });
    },
    [meetingId],
  );

  /** The text to display for a read-only row: the correction where there is one. */
  const shown = (m: Minute) =>
    editedText(ed, 'minute', itemKey(m.content), minuteText(m)) ?? minuteText(m);

  const nothing = actions.length === 0 && decisions.length === 0 && questions.length === 0;
  const todo = actions.filter(m => !done.has(itemKey(m.content)));
  const finished = actions.filter(m => done.has(itemKey(m.content)));
  const pct = actions.length ? finished.length / actions.length : 0;

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
            <View style={st.list}>{todo.map((m, i) => row(m, false, `t${i}`))}</View>
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
                <View style={st.list}>{finished.map((m, i) => row(m, true, `d${i}`))}</View>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {decisions.length > 0 ? (
        <>
          <SectionHead label="DECIDED" count={decisions.length} colors={colors} style={st.heading} />
          <View style={st.list}>
            {decisions.map((m, i) => (
              <Raised key={m.id ?? i} edge={colors.line} fill={colors.card} rad={radius.xl} depth={4}>
                <View style={st.plain}>
                  <View style={[st.rule, { backgroundColor: colors.primary }]} />
                  <Txt variant="prose" style={st.flex}>
                    {sentenceCase(splitAction(shown(m)).text)}
                  </Txt>
                </View>
              </Raised>
            ))}
          </View>
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
          <View style={st.list}>
            {questions.map((m, i) => (
              <Raised key={m.id ?? i} edge={colors.line} fill={colors.card} rad={radius.xl} depth={4}>
                <View style={st.plain}>
                  <View style={[st.rule, { backgroundColor: colors.success }]} />
                  <Txt variant="prose" style={st.flex}>
                    {sentenceCase(splitAction(shown(m)).text)}
                  </Txt>
                </View>
              </Raised>
            ))}
          </View>
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
    tags: { flexDirection: 'row', flexWrap: 'wrap', gap: s(6), marginTop: s(8) },
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
