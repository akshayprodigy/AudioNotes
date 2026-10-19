# Execution sheet — the Pro door on the Library, and a paywall you can buy from without scrolling

*Written 19 Oct 2026 by Opus (the brain) for a Sonnet builder session. Anchors were grepped on
`main` at `4fb28d5` the day this was written. Founder decisions, fixed: Pro pill in brand indigo
with the `ai` icon; Free users lose the Actions icon in the header (the pill replaces it; Paid
keeps Actions and sees no pill); with no trial, the button states price AND period.*

**Goal.** From the Library, a Free user reaches Play's purchase sheet in two taps: the Pro pill
(or the allowance line), then the buy button. On the Pro screen, the plan picker, the buy button
and the trial terms are pinned to the bottom and never scroll away; above them, three one-line
highlights; the full feature list stays below, scrollable.

---

## 1. Rules

- Do exactly the steps in §4, in order. Do not redesign, rename or "improve" anything else.
- TDD per step: write/update the test first, see it fail, implement, see it pass. Run the named
  mutant: make the break, confirm the named test fails, revert the break.
- One commit per step, subject given in the step. End each commit message with
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. **Never push.**
- Indent like the surrounding file (2 spaces). Match the comment density of the file you edit.
- Pipe every command's output through `tail`/`grep` as given in §6. Read only the files in §2,
  only at those ranges (you may widen a range by ±30 lines to place an edit).
- **No phone.** Never run the bare gate. The only gate command allowed is
  `GATE_STAGES="types js scans" scripts/gate.sh`. Never run `adb`.
- `git status` must be clean when you stop.

## 2. Relevant files (the only ones to read)

| File | Lines | Why |
|---|---|---|
| `src/screens/PaywallScreen.tsx` | 1–35, 150–160, 340–620 | imports; component start; the whole render + styles (being restructured) |
| `src/screens/__tests__/PaywallScreen.test.tsx` | 1–181 | the paywall's tests (some updated, some added) |
| `src/screens/LibraryScreen.tsx` | 1–50, 322–332, 414–435, 695–740, 990–1000 | imports; the two `setPaid` sites; the header; `headBtns` style |
| `src/screens/__tests__/LibraryScreen.test.tsx` | 1–60, 92–175, 380–430 | helpers; the Actions-header tests; the Free-allowance describe |
| `src/screens/AllowanceNote.tsx` | 1–50 | `AllowanceLine` gains an optional `onPress` |
| `src/screens/LibrarySummary.tsx` | 1–86 | the summary strip gains an optional `onUpgrade` |
| `src/share/SharePreviewScreen.tsx` | 125–135 | the export gate passes `from: 'export'` |
| `src/navigation/RootNavigator.tsx` | 70–73 | the `Paywall` route params |
| `src/components/ui.tsx` | 145–175, 258–345 | `Raised`, `Button`, `IconButton` props (read only) |

Facts you do not need to verify: `IconName` includes `ai`, `inbox`, `edit`, `share`, `search`,
`chevronRight`. Theme colours used below all exist: `primary`, `primaryTop`, `primaryEdge`,
`primaryDeep`, `primarySoft`, `onPrimary`, `ink`, `inkSoft`, `inkFaint`, `line`, `card`.
`radius.md` exists. Text variants used below all exist: `display`, `sub`, `bodyBlack`,
`metaBlack`, `chip`, `overlineSm`.

## 3. Files that must not change

`src/components/ui.tsx`, `src/components/Icon.tsx`, `src/theme/**`, `src/billing/**` except the
new file in Step 1 and its test, `src/screens/summaryStats.ts`, `src/billing/allowanceCopy.ts`,
everything under `android/`, `jest.setup.js`, `scripts/**`. Copy strings not listed in this sheet
stay byte-identical (`INCLUDED`, `FREE_FOREVER`, the trial-terms sentence, every Alert).

## 4. Implementation sequence

### Step 1 — `proHighlights`, a pure function

Create `src/billing/proHighlights.ts`:

```ts
import type { IconName } from '../components/Icon';

/**
 * The three lines the Pro screen shows above the fold — the whole pitch for somebody who reads
 * nothing else. Pure, so the choice is testable without rendering the screen.
 *
 * Meetings lead: the monthly limit is the thing a Free user actually runs into. The written
 * minutes come second, but only on a phone that can run the writer — on a phone under the
 * writer's gate the most visible promise on the page would be false, so search by meaning takes
 * its place. Somebody sent here by the export gate sees export first: that is what they tapped.
 */
export type Highlight = { key: 'meetings' | 'writer' | 'export' | 'meaning'; icon: IconName; text: string };

const MEETINGS: Highlight = { key: 'meetings', icon: 'inbox', text: 'Unlimited meetings, any length' };
const WRITER: Highlight = { key: 'writer', icon: 'edit', text: 'Minutes written for you, in sentences' };
const EXPORT: Highlight = { key: 'export', icon: 'share', text: 'Export to PDF, MP3, SRT and more' };
const MEANING: Highlight = { key: 'meaning', icon: 'search', text: 'Search by what was meant, not only said' };

export function proHighlights(from: 'onboarding' | 'export' | undefined, writerRuns: boolean): Highlight[] {
  const second = writerRuns ? WRITER : MEANING;
  return from === 'export' ? [EXPORT, MEETINGS, second] : [MEETINGS, second, EXPORT];
}
```

Create `src/billing/__tests__/proHighlights.test.ts` with exactly these four tests:

1. `proHighlights(undefined, true).map(h => h.key)` equals `['meetings', 'writer', 'export']`.
2. `proHighlights(undefined, false).map(h => h.key)` equals `['meetings', 'meaning', 'export']`,
   and no item's `text` matches `/written|minutes/i`.
3. `proHighlights('export', true).map(h => h.key)` equals `['export', 'meetings', 'writer']`.
4. `proHighlights('onboarding', true)` equals `proHighlights(undefined, true)`.

Mutant: change `writerRuns ? WRITER : MEANING` to `WRITER` → test 2 fails.
Commit: `feat(paywall): proHighlights picks the three above-the-fold lines`

### Step 2 — the `Paywall` route accepts `from: 'export'`, and the export gate sends it

`src/navigation/RootNavigator.tsx`, the line
`  Paywall: { meetingId?: string; from?: 'onboarding' } | undefined;` becomes
`  Paywall: { meetingId?: string; from?: 'onboarding' | 'export' } | undefined;`

`src/share/SharePreviewScreen.tsx`, the line
`        navigation.navigate('Paywall', { meetingId });` (inside the `PRO_REQUIRED` branch) becomes
`        navigation.navigate('Paywall', { meetingId, from: 'export' });`

No new test (types only; `tsc` in the gate checks it). Run `npx tsc --noEmit | tail -5` → no errors.
Commit: `feat(paywall): the export gate tells the Pro screen where the buyer came from`

### Step 3 — the Pro screen: pinned buy dock, compact hero, three highlights

**Tests first** — in `src/screens/__tests__/PaywallScreen.test.tsx`:

a) Change the `render` helper's parameter type to `params?: { from?: 'onboarding' | 'export' }`.

b) In `'states the price when Play offers this account no trial'`, the label
`'Subscribe — ₹2,499'` becomes `'Subscribe — ₹2,499 a year'`.

c) Add a new describe at the end of the file:

```tsx
describe('PaywallScreen can be bought from without scrolling', () => {
  const { ScrollView } = require('react-native');

  it('keeps the buy button and the trial terms outside the scroll', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    const tree = await render();
    const scroll = tree.root.findByType(ScrollView);
    expect(tree.root.findAllByProps({ label: 'Try it free for 7 days' }, { deep: false })).toHaveLength(1);
    expect(scroll.findAllByProps({ label: 'Try it free for 7 days' }, { deep: false })).toHaveLength(0);
    const terms = 'Free for 7 days, then ₹2,499 a year until you cancel. Cancel in Google Play before the trial ends and you pay nothing.';
    expect(texts(tree)).toContain(terms);
    expect(scroll.findAll(n => n.props.children === terms)).toHaveLength(0);
  });

  it('keeps Restore inside the scroll, not in the pinned dock', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    const tree = await render();
    const scroll = tree.root.findByType(ScrollView);
    expect(scroll.findAllByProps({ label: 'Restore purchase' }, { deep: false })).toHaveLength(1);
  });

  const highlightKeys = (tree: renderer.ReactTestRenderer) =>
    tree.root
      .findAll(n => typeof n.props.testID === 'string' && n.props.testID.startsWith('highlight-'), { deep: false })
      .map(n => n.props.testID as string);

  it('leads with three highlights, meetings first', async () => {
    const tree = await render();
    expect(highlightKeys(tree)).toEqual(['highlight-meetings', 'highlight-writer', 'highlight-export']);
  });

  it('sent by the export gate, export leads', async () => {
    const tree = await render({ from: 'export' });
    expect(highlightKeys(tree)[0]).toBe('highlight-export');
  });

  it('still lists every Pro feature below the highlights', async () => {
    const tree = await render();
    const all = texts(tree);
    for (const title of ['Export: MP3, PDF, SRT, Markdown, text', 'More meetings, any length', 'The larger transcriber']) {
      expect(all).toContain(title);
    }
  });
});
```

Run the file; the new describe's first, third and fourth tests and the changed label test fail.

**Implement** in `src/screens/PaywallScreen.tsx`:

1. Add the import after the `trialTerms` import line:
   `import { proHighlights } from '../billing/proHighlights';`

2. Replace the `headline` constant's Free branch. The block

   ```tsx
   const headline = bought
     ? 'You are on Pro. Everything below is already on.'
     : 'More meetings with no length limit, and minutes the phone writes for you in sentences.';
   ```
   becomes
   ```tsx
   const headline = bought
     ? 'You are on Pro. Everything below is already on.'
     : 'Everything Free does, without the limits.';
   ```
   (The old line promised written minutes on every phone, including ones that cannot run the writer.)

3. Replace the `priceLabel` block with:

   ```tsx
   // With no trial to lead with, the button carries the price and how often it is charged, so the
   // one thing a buyer reads before Play's sheet is the whole cost.
   const per = chosen?.period === 'P1Y' ? ' a year' : chosen?.period === 'P1M' ? ' a month' : '';
   const priceLabel = chosenFree
     ? `Try it free for ${chosenFree}`
     : playCost
       ? `Subscribe — ${playCost}${per}`
       : 'Subscribe';

   const highlights = proHighlights(route.params?.from, writerBlocked === null);
   ```

4. Replace everything from `  return (` (the component's render, directly after `priceLabel`) down
   to and including the closing `  );` of the component with:

   ```tsx
   return (
     <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
       <View style={st.nav}>
         <IconButton icon="x" label="Close" onPress={() => navigation.goBack()} />
       </View>

       <ScrollView
         ref={scroller}
         style={st.flex}
         showsVerticalScrollIndicator={false}
         contentContainerStyle={st.body}>
         <Pop style={st.hero}>
           <Mascot mood={bought ? 'happy' : 'idle'} size={sv(56)} />
           <View style={st.flex}>
             <Txt variant="display">Verbale Pro</Txt>
             <Txt variant="sub" color={colors.inkSoft}>
               {headline}
             </Txt>
           </View>
         </Pop>

         {/* The pitch for somebody who reads nothing else: three lines, all above the fold. */}
         <Pop index={1} style={st.highlights}>
           {highlights.map(h => (
             <View key={h.key} style={st.highlight} testID={`highlight-${h.key}`}>
               <View style={[st.highlightIcon, { backgroundColor: colors.primarySoft }]}>
                 <Icon name={h.icon} size={s(18)} color={colors.primary} strokeWidth={2.4} />
               </View>
               <Txt variant="bodyBlack" style={st.flex}>
                 {h.text}
               </Txt>
             </View>
           ))}
         </Pop>

         <Txt variant="overlineSm" color={colors.inkFaint} style={st.allTitle}>
           EVERYTHING IN PRO
         </Txt>
         <View style={st.list}>
           {/* ← the existing INCLUDED.map(...) block, moved here UNCHANGED (keep Pop index={i + 2}) */}
         </View>

         {/* ← the existing floor block (comment + <Pop index={INCLUDED.length + 2} style={st.floorWrap}>…</Pop>), moved here UNCHANGED */}

         {/* Restore and sign-in are for the few who already paid. They stay findable, below the
             list, and out of the pinned dock, which is for people deciding. */}
         {!bought ? (
           <View style={st.after}>
             {/* ← the existing `playCan && !bought ? <SoftButton … Restore purchase … /> : null` block, UNCHANGED */}
             {/* ← the existing sign-in comment + `!ent?.licence?.paid ? (<View style={st.signIn}>…</View>) : null` block, UNCHANGED */}
           </View>
         ) : null}
       </ScrollView>

       {/* Pinned: the plan, the button and the terms never scroll away. Play's policy wants the
           price and the trial terms beside the offer, and a buyer should not have to hunt for it. */}
       <View
         style={[
           st.dock,
           { backgroundColor: colors.card, borderTopColor: colors.line, paddingBottom: insets.bottom + s(12) },
         ]}>
         {/* ← the existing `dl !== null ? (<View style={st.dl}>…</View>) : null` block, UNCHANGED */}
         {bought ? (
           <SoftButton icon="check" label="Close" onPress={() => navigation.goBack()} />
         ) : playCan ? (
           <>
             {/* ← the existing plans row (`plans.length > 1 ? (<View style={st.plans}>…</View>) : null`), UNCHANGED */}
             {/* ← the existing <Button … label={busy === 'buy' ? 'One moment…' : priceLabel} … />, UNCHANGED */}
             {/* ← the existing four notes, UNCHANGED and in this order: terms; "Pro downloads a … MB model…";
                  spaceShort; "The Play Store has not sent the price yet…" (with its comment) */}
           </>
         ) : (
           <Txt variant="chip" color={colors.inkFaint} style={st.note}>
             This install cannot buy through the Play Store. If you already subscribed elsewhere, use
             "Subscribed on the web? Sign in" above and it will be picked up here.
           </Txt>
         )}
       </View>
     </View>
   );
   ```

   Every `← … UNCHANGED` comment means: cut that JSX from the old render and paste it at that
   spot, byte-for-byte; delete the placeholder comment. Nothing else from the old render survives
   (the old `st.cta` wrapper, the hero's centred text and the old "sign in below" sentence go).

5. In `makeStyles`, re-indent the block from `plans: {` to the end of `wasPrice: { … },` to the
   4-space depth of its siblings (it is currently 2 spaces), then apply these style changes:
   - `body` becomes `{ paddingHorizontal: s(20), paddingTop: s(4), paddingBottom: s(24) }`
   - `hero` becomes `{ flexDirection: 'row', alignItems: 'center', gap: s(14) }`
   - delete `heroText`, `heroSub`, `centerText`, `cta`
   - `list` becomes `{ gap: s(10), marginTop: s(10) }`
   - `plans` `marginBottom` becomes `s(10)`
   - add after `hero`:
     ```ts
     highlights: { marginTop: s(18), gap: s(12) },
     highlight: { flexDirection: 'row', alignItems: 'center', gap: s(12) },
     highlightIcon: {
       width: s(36),
       height: s(36),
       borderRadius: radius.md,
       alignItems: 'center',
       justifyContent: 'center',
     },
     allTitle: { marginTop: s(26) },
     ```
   - add after `dl`:
     ```ts
     after: { marginTop: s(20), gap: s(10) },
     dock: {
       paddingHorizontal: s(20),
       paddingTop: s(12),
       gap: s(8),
       borderTopWidth: StyleSheet.hairlineWidth,
     },
     ```
   - `signIn` becomes `{ marginTop: s(8) }`
   - `dl` becomes `{ gap: s(8) }`

6. Update the comment above `const scroller = useRef<ScrollView>(null);` to:
   `// The trial's download progress shows in the pinned dock; the scroll goes back to the top so the`
   `// highlights and the headline ("You are on Pro") are what the buyer sees next to it.`

Run the paywall test file → all green. Run `npx tsc --noEmit | tail -5` → no errors.

Mutant: move the dock `<View style={[st.dock …]}>` block inside the `</ScrollView>` → test
`keeps the buy button and the trial terms outside the scroll` fails. Revert.
Commit: `feat(paywall): pin the plan, the button and the terms; three highlights above the fold`

### Step 4 — the Pro pill replaces Actions in a Free Library header

**Tests first** — in `src/screens/__tests__/LibraryScreen.test.tsx`:

a) Replace the whole test `'the Actions header button reads "Actions (Pro)" and opens the paywall on free'` with:

```tsx
  test('on free the header has a "Get Pro" pill in place of Actions, and it opens the paywall', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const tree = await focusTheLibrary();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Actions' }, { deep: false })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Actions (Pro)' }, { deep: false })).toHaveLength(0);
    await act(async () => {
      pressIconButton(tree, 'Get Pro');
    });
    expect((nav as any).navigate).toHaveBeenCalledWith('Paywall');
    await act(async () => tree.unmount());
  });
```

b) In `'paid keeps the outstanding-actions card and the plain "Actions" label'`, add before the unmount:
`    expect(tree.root.findAllByProps({ accessibilityLabel: 'Get Pro' }, { deep: false })).toHaveLength(0);`

c) In `'buying Pro on the Pro screen is noticed when the library is focused again'`, the first
expectation's `'Actions (Pro)'` becomes `'Get Pro'`, and add after the final `'Actions'` expectation:
`    expect(tree.root.findAllByProps({ accessibilityLabel: 'Get Pro' }, { deep: false })).toHaveLength(0);`

Run the file → (a) and (c) fail.

**Implement.**

1. Create `src/screens/ProPill.tsx`:

```tsx
import React from 'react';
import { StyleSheet, View } from 'react-native';
import Icon from '../components/Icon';
import { Raised, Txt } from '../components/ui';
import { radius, s, useTheme } from '../theme';

/**
 * The Library's way into Pro, on a Free phone only. Filled, so it reads as the one place to buy
 * rather than one more tool, and the same height as the icon buttons beside it so the header stays
 * one row. It takes the Actions button's slot: on Free that button only ever opened the paywall.
 */
export default function ProPill({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="button" accessibilityLabel="Get Pro">
      <Raised
        edge={colors.primaryEdge}
        gradient={{ from: colors.primaryTop, to: colors.primary }}
        rad={radius.md}
        depth={3}
        onPress={onPress}>
        <View style={st.body}>
          <Icon name="ai" size={s(16)} color={colors.onPrimary} strokeWidth={2.6} />
          <Txt variant="metaBlack" color={colors.onPrimary}>
            Pro
          </Txt>
        </View>
      </Raised>
    </View>
  );
}

const st = StyleSheet.create({
  body: { height: s(40), flexDirection: 'row', alignItems: 'center', gap: s(5), paddingHorizontal: s(12) },
});
```

2. `src/screens/LibraryScreen.tsx`:
   - Add `import ProPill from './ProPill';` after `import ProNudgeCard from './ProNudgeCard';`.
   - After `  const [paid, setPaid] = useState(false);` add:
     ```tsx
     // Until the first answer the header draws neither the pill nor Actions, so a Pro user never
     // sees "Pro" flash up for a frame before the entitlement lands.
     const [paidKnown, setPaidKnown] = useState(false);
     ```
   - `      entitlement().then(e => setPaid(e.paid)).catch(() => {});` becomes
     `      entitlement().then(e => { setPaid(e.paid); setPaidKnown(true); }).catch(() => {});`
   - `      if (alive) setPaid(ent.paid);` becomes
     `      if (alive) { setPaid(ent.paid); setPaidKnown(true); }`
   - Replace the header's Actions button

     ```tsx
            <IconButton
              icon="list"
              label={paid ? 'Actions' : 'Actions (Pro)'}
              onPress={() => navigation.navigate(paid ? 'Actions' : 'Paywall')}
            />
     ```
     with
     ```tsx
            {paidKnown ? (
              paid ? (
                <IconButton icon="list" label="Actions" onPress={() => navigation.navigate('Actions')} />
              ) : (
                <ProPill onPress={() => navigation.navigate('Paywall')} />
              )
            ) : null}
     ```

Run the Library test file → green.
Mutant: in the pill's `onPress`, navigate to `'Actions'` → test (a) fails. Revert.
Commit: `feat(library): a Pro pill in the header for Free, in the Actions slot`

### Step 5 — the allowance line and the summary strip open the Pro screen

**Tests first** — inside `describe('the Free allowance', …)` in the Library test file, add:

```tsx
  test('with nothing recorded, the allowance line opens the Pro screen', async () => {
    const tree = await focusTheLibrary();
    const [line] = tree.root.findAllByProps(
      { accessibilityLabel: '3 of 5 free meetings left · resets 1 November. Go unlimited with Pro.' },
      { deep: false },
    );
    await act(async () => line.props.onPress());
    expect((nav as any).navigate).toHaveBeenCalledWith('Paywall');
    await act(async () => tree.unmount());
  });

  test('with meetings saved, the summary strip opens the Pro screen on Free', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([saved]);
    const tree = await focusTheLibrary();
    const strip = tree.root.findAll(n => n.props.testID === 'library-summary', { deep: false })[0];
    expect(strip.props.accessibilityLabel).toContain('Go unlimited with Pro.');
    await act(async () => strip.props.onPress());
    expect((nav as any).navigate).toHaveBeenCalledWith('Paywall');
    await act(async () => tree.unmount());
  });
```

And in the existing `'Pro sees no allowance line'` test, the expectation
`expect(summary(tree)).toBe('1 meeting saved. 10 min captured.');` stays exactly as it is (it
proves Pro gets no upsell in the strip).

Run → both new tests fail.

**Implement.**

1. `src/screens/AllowanceNote.tsx` — replace `AllowanceLine` with:

```tsx
/**
 * "3 of 5 free meetings left · resets 1 November." — nothing for Pro. With [onPress] (the Library)
 * it is also the way to Pro: the line people read when they wonder how many are left is the right
 * place to say there is a version without a count. Record passes none and stays a plain line.
 */
export function AllowanceLine({ status, onPress }: { status: AllowanceStatus | null; onPress?: () => void }) {
  const { colors } = useTheme();
  const line = statusLine(status);
  if (!line) return null;
  if (!onPress) {
    return (
      <Txt variant="chip" color={colors.inkDim} style={styles.line}>
        {line}
      </Txt>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${line} Go unlimited with Pro.`}
      onPress={onPress}
      style={styles.line}>
      <Txt variant="chip" color={colors.inkDim}>
        {line}
      </Txt>
      <Txt variant="chip" color={colors.primaryDeep} style={styles.link}>
        Go unlimited with Pro ›
      </Txt>
    </Pressable>
  );
}
```
   - The `react-native` import becomes `import { Pressable, StyleSheet, View } from 'react-native';`
   - Add `link: { marginTop: s(2) },` to `styles`.

2. `src/screens/LibrarySummary.tsx`:
   - The `react-native` import becomes `import { PixelRatio, Pressable, StyleSheet, View } from 'react-native';`
   - Add `import Icon from '../components/Icon';` after the `ui` import.
   - Props: add `onUpgrade,` to the destructure and `onUpgrade?: () => void;` to the type.
   - After `const spoken = …;` add:
     ```tsx
     // On Free the strip is also the way to Pro: the FREE LEFT figure is where somebody notices the
     // count. Pro has no free cell, so it never gets the link.
     const upgrade = onUpgrade && stats.some(x => x.key === 'free') ? onUpgrade : undefined;
     ```
   - The outer `<View style={st.wrap} accessible accessibilityLabel={spoken} testID="library-summary">`
     becomes
     ```tsx
     <Pressable
       style={st.wrap}
       accessible
       accessibilityRole={upgrade ? 'button' : undefined}
       accessibilityLabel={upgrade ? `${spoken} Go unlimited with Pro.` : spoken}
       testID="library-summary"
       disabled={!upgrade}
       onPress={upgrade}>
     ```
     and its closing `</View>` (the last one before `  );`) becomes `</Pressable>`.
   - Directly after the stats row's closing `</View>` (the one opened by
     `<View style={stacked ? st.col : st.row} …>`), still inside `<Raised>`, add:
     ```tsx
     {upgrade ? (
       <View style={[st.upgrade, { borderColor: colors.line }]} importantForAccessibility="no-hide-descendants">
         <Txt variant="chip" color={colors.primaryDeep}>
           Go unlimited with Pro
         </Txt>
         <Icon name="chevronRight" size={s(14)} color={colors.primaryDeep} strokeWidth={2.6} />
       </View>
     ) : null}
     ```
   - Add to `st`: `upgrade: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: s(4), paddingVertical: s(10), borderTopWidth: StyleSheet.hairlineWidth },`
   - Update the component's doc comment: append the sentence
     `On a Free phone, given [onUpgrade], the whole strip opens the Pro screen.`

3. `src/screens/LibraryScreen.tsx`:
   - `<AllowanceLine status={allowance} />` becomes
     `<AllowanceLine status={allowance} onPress={() => navigation.navigate('Paywall')} />`
   - `<LibrarySummary saved={own.length} capturedMin={totalMin} allowance={allowance} />` becomes
     ```tsx
     <LibrarySummary
       saved={own.length}
       capturedMin={totalMin}
       allowance={allowance}
       onUpgrade={() => navigation.navigate('Paywall')}
     />
     ```

Run the Library test file and `src/screens/__tests__/RecordScreen.allowance.test.tsx` → green.
Mutant: in `LibrarySummary`, change `stats.some(x => x.key === 'free')` to `true` → `'Pro sees no
allowance line'` fails. Revert.
Commit: `feat(library): the allowance line and the summary strip open the Pro screen on Free`

### Step 6 — gate and report

Run `GATE_STAGES="types js scans" scripts/gate.sh 2>&1 | tail -30` → every stage PASS.

Write `docs/superpowers/reports/2026-10-19-pro-door-and-paywall-fold.md` with: §1 what was built
(one line per step, with its commit hash); §2 the mutant results (killed/survived, per step); §3
every deviation from this sheet, each with its cause; §4 "For the founder to test on a phone":
  1. Free phone, nothing recorded: the header shows Import, Search, **Pro**, Settings on one row;
     tapping Pro opens the Pro screen.
  2. Tapping "Go unlimited with Pro ›" under the allowance line opens the Pro screen.
  3. On the Pro screen at default font size, without scrolling: the title, three highlights, the
     Yearly/Monthly picker, the "Try it free for 7 days" button and the terms are all visible.
     Check on the Galaxy A07 (smallest screen).
  4. Scrolling moves the feature list; the picker, button and terms stay put.
  5. With a recording saved, the summary strip shows "Go unlimited with Pro ›" and opens the Pro screen.
  6. On a Pro account: no pill, the Actions icon is back, the strip has no link.
Commit: `docs(report): 19 Oct - Pro door on the Library, paywall bought without scrolling`

## 5. Expected interfaces after the sequence

- `proHighlights(from: 'onboarding' | 'export' | undefined, writerRuns: boolean): Highlight[]` (3 items)
- `RootStackParamList['Paywall']` = `{ meetingId?: string; from?: 'onboarding' | 'export' } | undefined`
- `ProPill({ onPress }: { onPress: () => void })`, accessibilityLabel `Get Pro`
- `AllowanceLine({ status, onPress? })`
- `LibrarySummary({ saved, capturedMin, allowance, onUpgrade? })`

## 6. Exact tests and commands

| Step | Command | Must show |
|---|---|---|
| 1 | `npx jest src/billing/__tests__/proHighlights.test.ts 2>&1 \| tail -8` | `Tests: 4 passed` |
| 2 | `npx tsc --noEmit 2>&1 \| tail -5` | no output |
| 3 | `npx jest src/screens/__tests__/PaywallScreen.test.tsx 2>&1 \| tail -8` | all passed, 0 failed |
| 4 | `npx jest src/screens/__tests__/LibraryScreen.test.tsx 2>&1 \| tail -8` | all passed, 0 failed |
| 5 | `npx jest src/screens/__tests__/LibraryScreen.test.tsx src/screens/__tests__/RecordScreen.allowance.test.tsx 2>&1 \| tail -8` | all passed, 0 failed |
| 6 | `GATE_STAGES="types js scans" scripts/gate.sh 2>&1 \| tail -30` | every stage PASS |

## 7. Acceptance criteria

- Every command in §6 shows what it must.
- `git diff --stat 4fb28d5..HEAD` names only: `src/billing/proHighlights.ts`,
  `src/billing/__tests__/proHighlights.test.ts`, `src/navigation/RootNavigator.tsx`,
  `src/share/SharePreviewScreen.tsx`, `src/screens/PaywallScreen.tsx`,
  `src/screens/__tests__/PaywallScreen.test.tsx`, `src/screens/ProPill.tsx`,
  `src/screens/LibraryScreen.tsx`, `src/screens/__tests__/LibraryScreen.test.tsx`,
  `src/screens/AllowanceNote.tsx`, `src/screens/LibrarySummary.tsx`, and the report.
- `grep -c "Actions (Pro)" src/screens/LibraryScreen.tsx` prints `0`.
- `INCLUDED` and `FREE_FOREVER` in `PaywallScreen.tsx` are unchanged: `git diff 4fb28d5..HEAD -- src/screens/PaywallScreen.tsx | grep -E "^[-+].*(title:|body:|FREE_FOREVER)"` prints nothing.
- Five commits for Steps 1–5 plus the report commit; `git status` clean; nothing pushed.

## 8. Stop conditions

- A step needs an API, prop, icon, colour or text variant not named in this sheet → stop, write
  what you needed in the report's §3, commit what is done.
- The same failure survives two fix attempts → stop and report it.
- A test fails in a file you did not touch → do not investigate; note it in the report and carry on.
- 150 tool calls used → commit what is done, write the report with what is left, stop.
