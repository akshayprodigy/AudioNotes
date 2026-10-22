import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Icon from '../components/Icon';
import { ProgressBar, Txt } from '../components/ui';
import { downloadLabel, downloadPct } from '../screens/downloadLabel';
import { s, useTheme } from '../theme';
import { shownDownloads, useActiveDownloads } from './activeDownloads';

/**
 * What is downloading right now, on the Library, by what it is for. Quiet when nothing is.
 * Not a card: a line and a bar per download, so it informs without taking the screen.
 */
export default function DownloadsStrip() {
  const { colors } = useTheme();
  const live = useActiveDownloads(st => st.live);
  const [now, setNow] = useState(() => Date.now());
  const any = Object.keys(live).length > 0;

  // Only while something is in flight: re-check every few seconds so a download that went quiet
  // drops off rather than sitting at its last percentage.
  useEffect(() => {
    if (!any) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [any]);

  const shown = shownDownloads(live, now);
  if (shown.length === 0) return null;

  return (
    <View style={sx.wrap} testID="downloads-strip">
      {shown.map(d => (
        <View
          key={d.id}
          style={sx.item}
          accessible
          accessibilityLabel={`Downloading: ${d.purpose || 'a feature'}, ${downloadLabel(d.downloaded, d.total)}`}>
          <View style={sx.line}>
            <Icon name="download" size={s(14)} color={colors.primaryDeep} strokeWidth={2.4} />
            <Txt variant="chip" color={colors.ink} style={sx.flex} numberOfLines={1}>
              {d.purpose || 'Downloading a feature'}
            </Txt>
            <Txt variant="chipSoft" color={colors.inkDim}>
              {downloadLabel(d.downloaded, d.total)}
            </Txt>
          </View>
          <ProgressBar pct={downloadPct(d.downloaded, d.total)} color={colors.primary} track={colors.cardAlt} />
        </View>
      ))}
    </View>
  );
}

const sx = StyleSheet.create({
  wrap: { marginHorizontal: s(20), marginTop: s(10), gap: s(10) },
  item: { gap: s(6) },
  line: { flexDirection: 'row', alignItems: 'center', gap: s(6) },
  flex: { flex: 1 },
});
