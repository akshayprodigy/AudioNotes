import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Raised, SoftButton, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Minute, MinuteKind } from '../../pipeline/types';
import {
  DOC_KEY,
  DocItem,
  EditedTag,
  Prose,
  SectionHead,
  ToolButton,
  editedText,
  isEdited,
  itemKey,
  minuteText,
  type EditMap,
} from './shared';

/**
 * MOM — the document you would send someone.
 *
 * Read-only by design. The Actions tab is where items get worked; a document that doubles as a
 * checklist reads as neither, which is the whole reason these are two tabs and not one.
 *
 * The narrative is prose written by the on-device model. The decisions and actions beneath it come
 * from rule extraction, so every one of them quotes something that was actually said — the two
 * halves are doing different jobs and the tab shows both.
 */
export default function MinutesTab({
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
}: {
  minutes: Minute[];
  onExport: () => void;
  /** The whole write-up on the clipboard — the same document Export would have shared. */
  onCopy?: () => void;
  edits?: EditMap;
  onEditItem?: (m: Minute) => void;
  onRevertItem?: (key: string) => void;
  onRemoveItem?: (id: string) => void;
  onAdd?: (kind: MinuteKind) => void;
  onEditNarrative?: (initial: string) => void;
  onRevertNarrative?: () => void;
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
  const decisions = minutes.filter(m => m.kind === 'decision');
  const actions = minutes.filter(m => m.kind === 'action');

  /** One item, with the user's correction over it and their own rows marked as theirs. */
  const item = (m: Minute, i: number) => {
    // The key is the stored column, the text is what reads well — see onEditMinute.
    const key = itemKey(m.content);
    return (
      <DocItem
        key={m.id ?? i}
        m={m}
        colors={colors}
        content={editedText(ed, 'minute', key, minuteText(m))}
        edited={isEdited(ed, 'minute', key)}
        mine={m.source === 'user'}
        onEdit={onEditItem ? () => onEditItem(m) : undefined}
        onRevert={onRevertItem ? () => onRevertItem(key) : undefined}
        onRemove={onRemoveItem && m.source === 'user' && m.id ? () => onRemoveItem(m.id) : undefined}
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
