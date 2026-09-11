import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Raised, SoftButton, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Item, Minute, MinuteKind } from '../../pipeline/types';
import {
  DOC_KEY,
  DocItem,
  EditedTag,
  Prose,
  SectionHead,
  ToolButton,
  editTargetOf,
  editedText,
  isEdited,
  toItemRows,
  type EditMap,
  type ItemRow,
} from './shared';
import { ProvenanceButton } from './ItemProvenance';

/**
 * MOM — the document you would send someone.
 *
 * Read-only by design. The Actions tab is where items get worked; a document that doubles as a
 * checklist reads as neither, which is the whole reason these are two tabs and not one.
 *
 * The narrative is prose written by the on-device model. The decisions and actions beneath it come
 * from rule extraction, so every one of them quotes something that was actually said — the two
 * halves are doing different jobs and the tab shows both.
 *
 * The narrative comes from `minutes`, which is where the model's prose lives and stays. The
 * decisions and actions come from `items`, which is what carries the moment each one was said —
 * see [toItemRows] for the two populations still read out of `minutes` alongside them, and for
 * which task removes each.
 */
export default function MinutesTab({
  items,
  minutes,
  onExport,
  onCopy,
  edits,
  onEditItem,
  onRevertItem,
  onRemoveItem,
  onAdd,
  onEditNarrative,
  onRevertNarrative,
  onOpenProvenance,
  canPlay,
}: {
  items: Item[];
  minutes: Minute[];
  onExport: () => void;
  /** The whole write-up on the clipboard — the same document Export would have shared. */
  onCopy?: () => void;
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
  onEditNarrative?: (initial: string) => void;
  onRevertNarrative?: () => void;
  /** Open the transcript at a moment, and play from it where there is still audio to play. */
  onOpenProvenance?: (ms: number) => void;
  /** False once the recording has been discarded. The links stay; only playback goes. */
  canPlay?: boolean;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const ed: EditMap = edits ?? new Map();

  const written = minutes.find(m => m.kind === 'narrative' && m.source === 'llm')?.content;
  // A hand-written write-up counts even where the model produced none: somebody on a phone that
  // cannot run the model still has minutes, and withholding them because no model wrote them
  // would be absurd.
  const narrative = editedText(ed, 'narrative', DOC_KEY, written);
  const narrativeEdited = isEdited(ed, 'narrative', DOC_KEY);
  const rows = React.useMemo(() => toItemRows(items, minutes), [items, minutes]);
  const decisions = rows.filter(r => r.kind === 'decision');
  const actions = rows.filter(r => r.kind === 'action');

  /** One item, with the user's correction over it and their own rows marked as theirs. */
  const item = (r: ItemRow) => {
    // Where this row's correction lives — on its item id where it has one, on the hash of its
    // stored text where it does not. Asked once per row, because reading it from one place and
    // writing it to another is the whole failure mode; see editTargetOf.
    const t = editTargetOf(r);
    return (
    <DocItem
      key={r.key}
      kind={r.kind}
      colors={colors}
      content={editedText(ed, t.kind, t.key, r.text) ?? r.text}
      edited={isEdited(ed, t.kind, t.key)}
      mine={r.mine}
      onEdit={onEditItem ? () => onEditItem(r) : undefined}
      onRevert={onRevertItem ? () => onRevertItem(r) : undefined}
      // `r.mine` and nothing else. The old gate also asked for `r.minuteId`, which a hand-typed
      // row stopped having the moment Task 12 moved it into `items` — leaving it would have taken
      // the remove button off every row that has ever had one, silently.
      onRemove={onRemoveItem && r.mine ? () => onRemoveItem(r) : undefined}
      provenance={
        // No anchor, no button. A row somebody typed never claimed to have been said at any
        // particular moment, and offering to "play from 0:00" would be inventing one.
        onOpenProvenance && r.anchorStartMs !== null ? (
          <ProvenanceButton
            anchorStartMs={r.anchorStartMs}
            onOpen={onOpenProvenance}
            canPlay={canPlay ?? false}
          />
        ) : undefined
      }
    />
    );
  };

  return (
    <ScrollView contentContainerStyle={st.pad} showsVerticalScrollIndicator={false}>
      <Raised edge={colors.line} fill={colors.card} rad={radius.card24} depth={5}>
        <View style={st.doc}>
          <SectionHead
            label="MINUTES"
            colors={colors}
            right={
              <View style={st.tools}>
                {onEditNarrative ? (
                  <ToolButton
                    icon="edit"
                    label="Edit"
                    hint="Correct the written minutes"
                    colors={colors}
                    onPress={() => onEditNarrative(narrative ?? '')}
                  />
                ) : null}
                {onCopy ? (
                  <ToolButton
                    icon="copy"
                    label="Copy"
                    hint="Copies the whole write-up, ready to paste"
                    colors={colors}
                    onPress={onCopy}
                  />
                ) : null}
              </View>
            }
          />
          {narrative ? (
            <>
              {/* Parsed into paragraphs and list items. Set as one block, the model's "- " lines
                  rendered as stray dashes running into the words after them. */}
              <Prose text={narrative} colors={colors} />
              {narrativeEdited ? (
                <EditedTag colors={colors} onRevert={onRevertNarrative} />
              ) : null}
            </>
          ) : (
            <>
              <Txt variant="bodyStrong" color={colors.inkDim}>
                No written minutes for this meeting
              </Txt>
              <Txt variant="body" color={colors.inkSoft}>
                The decisions and actions below were pulled out of the transcript by rule. Writing
                them up in plain English needs the language model.
              </Txt>
            </>
          )}
        </View>
      </Raised>

      {decisions.length === 0 && onAdd ? (
        <ToolButton
          icon="plus"
          label="Add a decision"
          hint="Add a decision the app did not pick up"
          colors={colors}
          onPress={() => onAdd('decision')}
        />
      ) : null}

      {decisions.length > 0 ? (
        <Raised edge={colors.line} fill={colors.card} rad={radius.card24} depth={5}>
          <View style={st.doc}>
            <SectionHead
              label="DECISIONS"
              count={decisions.length}
              colors={colors}
              right={
                onAdd ? (
                  <ToolButton
                    icon="plus"
                    label="Add"
                    hint="Add a decision the app did not pick up"
                    colors={colors}
                    onPress={() => onAdd('decision')}
                  />
                ) : undefined
              }
            />
            <View style={st.list}>{decisions.map(item)}</View>
          </View>
        </Raised>
      ) : null}

      {actions.length > 0 ? (
        <Raised edge={colors.line} fill={colors.card} rad={radius.card24} depth={5}>
          <View style={st.doc}>
            <SectionHead label="ACTION ITEMS" count={actions.length} colors={colors} />
            <View style={st.list}>{actions.map(item)}</View>
          </View>
        </Raised>
      ) : null}

      <SoftButton icon="share" label="Export minutes" onPress={onExport} />
    </ScrollView>
  );
}

function makeStyles(_c: Colors) {
  return StyleSheet.create({
    pad: { paddingHorizontal: s(16), paddingBottom: s(30), gap: s(14) },
    // One card per section rather than one card per item: a document reads as a document, and
    // twenty-nine separately raised, separately tilted cards read as a pile.
    doc: { padding: s(18), gap: s(14) },
    list: { gap: s(14) },
    tools: { flexDirection: 'row', gap: s(14) },
  });
}
