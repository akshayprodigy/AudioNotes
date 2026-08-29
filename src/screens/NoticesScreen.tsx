import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import Icon from '../components/Icon';
import { IconButton, Pop, Raised, SectionRule, Txt } from '../components/ui';
import { LICENCE_TEXTS, NOTICES, type LicenceId } from '../legal/notices';
import { radius, s, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Notices'>;

/**
 * Open-source notices.
 *
 * This screen is not decoration and it is not an "About" page. MIT, Apache-2.0, BSD-3-Clause and
 * the OFL each require their text to travel with the software, and this is the only place in the
 * app where that obligation is actually met. It used to list licence NAMES, which names the
 * obligation without discharging it.
 *
 * The texts are generated from the LICENSE files vendored in the repository — see
 * scripts/build-notices.py — so they cannot drift into a paraphrase.
 *
 * Grouped by licence rather than repeating an 11,000-character Apache text against each of the
 * three components that use it. The components list says who is covered by what; the texts below
 * are the licences themselves, in full.
 */
export default function NoticesScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState<LicenceId | null>(null);

  const inApp = NOTICES.filter(n => n.where === 'app');
  const models = NOTICES.filter(n => n.where === 'model');
  const licences = Object.keys(LICENCE_TEXTS) as LicenceId[];

  const row = (n: (typeof NOTICES)[number]) => (
    <View key={`${n.where}-${n.name}`} style={st.notice}>
      <View style={st.noticeHead}>
        <Txt variant="chip" style={st.flex}>
          {n.name}
        </Txt>
        <View style={[st.tag, { backgroundColor: colors.cardAlt }]}>
          <Txt variant="chipSm" color={colors.inkFaint}>
            {n.licence}
          </Txt>
        </View>
      </View>
      <Txt variant="chipSoft" color={colors.inkSoft}>
        {n.used}
      </Txt>
      {/* The copyright line is the part the licences literally require be reproduced. */}
      <Txt variant="chipSoft" color={colors.inkFaint}>
        {n.by}
      </Txt>
    </View>
  );

  return (
    <View style={[st.root, { paddingTop: insets.top + s(10) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <Txt variant="sectionTitle" style={st.flex}>
          Open-source notices
        </Txt>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + s(40) }}>
        <View style={st.intro}>
          <Txt variant="chip" color={colors.inkSoft}>
            This app is built on work other people gave away. Their licences are reproduced in
            full below, which is what those licences ask for in return.
          </Txt>
        </View>

        <View style={st.ruleWrap}>
          <SectionRule label="IN THE APP" />
        </View>
        <View style={st.list}>
          <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
            <View style={st.rowPad}>{inApp.map(row)}</View>
          </Raised>
        </View>

        <View style={st.ruleWrap}>
          <SectionRule label="MODELS DOWNLOADED ON FIRST RUN" />
        </View>
        <View style={st.list}>
          <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
            <View style={st.rowPad}>
              {/* Listed for the same reason as the bundled code: we serve these from our own
                  mirror, and serving them is distribution just as bundling them would be. */}
              {models.map(row)}
            </View>
          </Raised>
        </View>

        <View style={st.ruleWrap}>
          <SectionRule label="THE LICENCES" />
        </View>
        <View style={st.list}>
          {licences.map((id, i) => {
            const covered = NOTICES.filter(n => n.licence === id);
            const expanded = open === id;
            return (
              <Pop key={id} index={i}>
                <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
                  <Pressable
                    onPress={() => setOpen(expanded ? null : id)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    accessibilityLabel={`${id} licence text, covering ${covered.length} components`}
                    style={st.rowPad}>
                    <View style={st.noticeHead}>
                      <View style={st.flex}>
                        <Txt variant="cardTitleSm">{id}</Txt>
                        <Txt variant="chipSoft" color={colors.inkFaint}>
                          {covered.length === 1
                            ? covered[0].name
                            : `${covered.length} components · ${covered.map(c => c.name).join(', ')}`}
                        </Txt>
                      </View>
                      <Icon
                        name={expanded ? 'chevronUp' : 'chevronDown'}
                        size={s(18)}
                        color={colors.inkFaint}
                        strokeWidth={2.4}
                      />
                    </View>
                    {expanded ? (
                      <Txt variant="chipSoft" color={colors.inkSoft} style={st.licenceText}>
                        {LICENCE_TEXTS[id]}
                      </Txt>
                    ) : null}
                  </Pressable>
                </Raised>
              </Pop>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20) },
    intro: { paddingHorizontal: s(20), paddingTop: s(14) },
    ruleWrap: { marginHorizontal: s(20), marginTop: s(22), marginBottom: s(10) },
    list: { paddingHorizontal: s(20), gap: s(10) },
    rowPad: { padding: s(16) },
    notice: { paddingVertical: s(7) },
    noticeHead: { flexDirection: 'row', alignItems: 'center', gap: s(8) },
    tag: { paddingHorizontal: s(7), paddingVertical: s(2), borderRadius: radius.sm },
    // Monospace-ish leading: these are legal texts with hard-wrapped lines, and cramped line
    // height makes an 11,000-character licence genuinely unreadable rather than merely long.
    licenceText: { marginTop: s(12), lineHeight: s(18) },
  });
}
