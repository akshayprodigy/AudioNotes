import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Raised, SoftButton, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Minute } from '../../pipeline/types';
import { DocItem, Prose, SectionHead } from './shared';

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
}: {
  minutes: Minute[];
  onExport: () => void;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);

  const narrative = minutes.find(m => m.kind === 'narrative' && m.source === 'llm')?.content;
  const decisions = minutes.filter(m => m.kind === 'decision');
  const actions = minutes.filter(m => m.kind === 'action');

  return (
    <ScrollView contentContainerStyle={st.pad} showsVerticalScrollIndicator={false}>
      <Raised edge={colors.line} fill={colors.card} rad={radius.card24} depth={5}>
        <View style={st.doc}>
          <SectionHead label="MINUTES" colors={colors} />
          {narrative ? (
            // Parsed into paragraphs and list items. Set as one block, the model's "- " lines
            // rendered as stray dashes running into the words after them.
            <Prose text={narrative} colors={colors} />
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

      {decisions.length > 0 ? (
        <Raised edge={colors.line} fill={colors.card} rad={radius.card24} depth={5}>
          <View style={st.doc}>
            <SectionHead label="DECISIONS" count={decisions.length} colors={colors} />
            <View style={st.list}>
              {decisions.map((m, i) => (
                <DocItem key={m.id ?? i} m={m} colors={colors} />
              ))}
            </View>
          </View>
        </Raised>
      ) : null}

      {actions.length > 0 ? (
        <Raised edge={colors.line} fill={colors.card} rad={radius.card24} depth={5}>
          <View style={st.doc}>
            <SectionHead label="ACTION ITEMS" count={actions.length} colors={colors} />
            <View style={st.list}>
              {actions.map((m, i) => (
                <DocItem key={m.id ?? i} m={m} colors={colors} />
              ))}
            </View>
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
  });
}
