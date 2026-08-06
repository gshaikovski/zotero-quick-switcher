# Where this stands

**Ready for you to install and test.** Two adversarial review passes are folded in, and the offline
test suite passes (55 assertions). It has never been run inside Zotero — that is the next step, and
it is yours.

## Install

```sh
./build.sh
```

Then Zotero → **Tools → Plugins** → gear icon → **Install Plugin From File…** → pick
`build/zotero-quick-switcher-0.1.0.xpi` → restart Zotero. Press **Cmd+O**.

Full instructions, key bindings and preferences are in `README.md`.

## What to watch for on first run

These are the parts that static review cannot settle, ranked by how likely they are to bite. If
something looks wrong, **Help → Debug Output Logging → View Output** and look for `[quick-switcher]`.

1. **The hotkey while a PDF reader tab is focused.** The whole design rests on a capture-phase
   keydown listener on the chrome window seeing key events that originate inside the reader's
   `<browser>`. The source says it will (it is how Cmd+W closes a reader tab), but this is the one
   claim that most deserves a real test. Open a PDF, click into the page, press Cmd+O.
2. **Focus landing in the search box.** If the overlay appears but typing goes into the PDF instead,
   `_focusInput()` needs the retry it already has extended into something stronger.
3. **The overlay painting above the reader.** It is a `position: fixed` div, mirroring Zotero's own
   `#zotero-tab-cover`. If it renders behind the PDF, `SPEC.md` §2.1 documents the XUL `<panel>`
   fallback and what it costs.
4. **Ranking quality on your real library.** The scoring weights are reasoned, not tuned against
   your ~570 papers. If the wrong paper sits at the top for queries you actually type, that is
   worth telling me — it is a one-line change per weight in `src/engine.js`.

## History

- `SPEC.md` — implementation spec derived from reading the shipped Zotero 9.0.6 source. Authoritative.
- `REVIEW-FINDINGS.md` — review pass 1: 36 findings, 8 confirmed after adversarial verification.
- `REVIEW-FINDINGS-2.md` — review pass 2 over the rewritten code: 34 findings. Its verification pass
  was cut short by a session limit, so 13 findings are unadjudicated; each was assessed by hand
  before deciding whether to act.

Both passes are folded in. What was deliberately **not** fixed, with reasons:

- **Per-window index duplication.** With N main windows open you get N copies of the index and N
  rebuilds per item change. Correct but wasteful; irrelevant at one window, and hoisting it to a
  singleton is a real refactor.
- **`waitForDataLoad('item')` at attach time** force-loads item data Zotero defers. It is what makes
  the first Cmd+O instant. Revisit if startup feels slow.
- **`_pickReaderAttachment` omits the parent-URL tiebreak** from Zotero's `getBestAttachments`
  ordering, so on an item with several PDFs it can pick a different one than double-click would.
  Rare, and the sync resolution it buys is what keeps the "already open" badge cheap.
- **Popped-out reader windows** get no overlay — a separate window type that never receives
  `onMainWindowLoad`. Documented in the README.

## Ground truth

The extracted Zotero 9.0.6 source used to verify every API call lives at
`/Users/george/.claude/jobs/be8c93f2/tmp/omni`. It is a read-only copy out of
`/Applications/Zotero.app/Contents/Resources/app/omni.ja`; re-extract with `unzip` if the job dir is
cleaned up. Never write into the app or the Zotero profile.
