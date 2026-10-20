# Execution sheet: the empty Library's sub-lines go full width

*Written 20 Oct 2026 by Opus for a Sonnet builder. Base: `main` at `a6575da`. Anchors grepped the
day of writing.*

**Why.** The emulator check at the Galaxy A07's size (720×1600 @ 300 dpi) found a problem. The
Pro pill is wider than the icon button it replaced, so the column under "Meetings" got narrower.
On an empty Library, "Nothing recorded yet" wraps to 2 lines, the allowance line to 3 and
"Go unlimited with Pro ›" to 2. The fix: the header row holds only the title and the buttons, and
the three lines sit under it at full width.

## 1. Rules

TDD with the named mutant; one commit; end the message with
`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; never push; never run adb or the
bare gate (only `GATE_STAGES="types js scans" scripts/gate.sh`); indent like the file (2 spaces);
`git status` clean when you stop.

## 2. Relevant files (read only these)

| File | Lines | Why |
|---|---|---|
| `src/screens/LibraryScreen.tsx` | 698–742, 996–1010 | the header block; the `header` / `sub` styles |
| `src/screens/__tests__/LibraryScreen.test.tsx` | 81–91, 380–440 | the title test; the Free-allowance describe (has the allowance-line press test) |

## 3. Must not change

Everything else, including `AllowanceNote.tsx`, `ProPill.tsx` and `LibrarySummary.tsx`, and
every copy string.

## 4. Steps

**Test first.** In `LibraryScreen.test.tsx`, inside `describe('the Free allowance', …)`, add:

```tsx
  test('on an empty library the sub-lines sit under the header row, not squeezed beside the buttons', async () => {
    const tree = await focusTheLibrary();
    const row = tree.root.findAll(n => n.props.testID === 'library-header', { deep: false })[0];
    const inRow = row.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);
    expect(inRow).toContain('Meetings');
    expect(inRow).not.toContain('Nothing recorded yet');
    expect(inRow).not.toContain('3 of 5 free meetings left · resets 1 November.');
    const all = texts(tree);
    expect(all).toContain('Nothing recorded yet');
    expect(all).toContain('3 of 5 free meetings left · resets 1 November.');
    await act(async () => tree.unmount());
  });
```

Run it → it fails (there is no `library-header` testID yet).

**Implement** in `src/screens/LibraryScreen.tsx`:

1. `        <View style={st.header}>` becomes `        <View style={st.header} testID="library-header">`.
2. Inside that header's `<View style={st.flex}>`, delete the comment
   `{/* With something recorded the numbers live in the strip below the header, …only ever fit a title. */}`
   and the whole `{own.length === 0 ? ( <> …Nothing recorded yet… <AllowanceLine … /> </> ) : null}`
   block. The `st.flex` view is left holding only the `Meetings` title.
3. Directly after the header's closing `        </View>` (the line before the blank line and
   `        {own.length > 0 ? (`), insert:

```tsx
        {/* Under the row, at full width. Beside the buttons the column is only as wide as what is
            left after four of them, and on a 360 dp phone that wrapped every one of these lines.
            With something recorded the numbers move to the summary strip instead. */}
        {own.length === 0 ? (
          <View style={st.headSub}>
            <Txt variant="sub" color={colors.inkDim}>
              Nothing recorded yet
            </Txt>
            <AllowanceLine status={allowance} onPress={() => navigation.navigate('Paywall')} />
          </View>
        ) : null}
```

4. In the styles, `    sub: { marginTop: s(6) },` becomes
   `    headSub: { paddingHorizontal: s(20), marginTop: s(6) },`.
   Then run `grep -n "st\.sub\b" src/screens/LibraryScreen.tsx`. It must print nothing. If it
   prints a line, `sub` is used somewhere else: keep `sub` and add `headSub` as a new line under it.

Run `npx jest src/screens/__tests__/LibraryScreen.test.tsx 2>&1 | tail -8` → all passed.
Mutant: move the `<View style={st.headSub}>…</View>` block back inside the header's `st.flex`
view → the new test fails. Revert.
Run `GATE_STAGES="types js scans" scripts/gate.sh 2>&1 | tail -6` → `gate: all clear`.
Commit: `fix(library): the empty library's sub-lines go full width under the header row`

## 5. Acceptance

- `git diff --stat a6575da..HEAD` names only the two files in §2, plus this sheet.
- One commit (plus this sheet's own commit); clean tree; nothing pushed.

## 6. Stop conditions

Anything outside §2 seems to need changing → stop and report. Two failed fixes of one failure
→ stop and report. A failure in an untouched file → note it, don't investigate.
