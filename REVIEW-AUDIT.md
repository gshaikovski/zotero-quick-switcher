# Disposition of every review finding

Two adversarial review passes ran against this code. Pass 2's verification layer was cut short by a
session limit — all four reviewers finished, so no findings were lost, but 13 of its 34 findings
never received a skeptic verdict.

This file records what happened to **all 34**, so the coverage claim is checkable rather than
asserted. Raw findings are in `REVIEW-FINDINGS.md` (pass 1) and `REVIEW-FINDINGS-2.md` (pass 2).

Duplicates: several findings were raised by more than one reviewer (3/14, 6/15, 16/20, 23/25,
24/27, 7/28). They are listed once, at the higher severity.

## Fixed

| # | Sev | Finding | Fix |
|---|---|---|---|
| 2 | HIGH | Pasted citation title ending in a period scored the right paper at 0 and opened an unrelated one | `normalize()` folds all punctuation on both index and query |
| 1 | HIGH | Items whose only attachment is a `.docx`/image never opened, just got revealed | gate now asks `_hasAnyAttachment`, not the reader-openable one |
| 3 | HIGH | Item change during a rebuild was swallowed by the build that was already running | `_dirty` cleared up front; `_building` checked before `_dirty` |
| 4 | HIGH | `open()` nulled the pointer baseline, so the first synthesized mousemove stole the preselection | first move only establishes the baseline |
| 5 | HIGH | NFC left accents intact, so `muller` could not find *Müller* | NFD + strip combining marks |
| 6 | HIGH | Escape left the chrome window with nothing focused | `close()` restores `_prevFocus` |
| 7 | HIGH | Tab moved focus behind a still-visible modal that kept swallowing Enter | Tab consumed, focus returned to the input |
| 8 | MED | Notifier observer leaked for the session when the window was already dead at unload | bootstrap keeps its own `windowState` registry of observer ids |
| 9 | MED | `shutdown()` could not cancel an in-flight attach; `startup()` discarded the record | `generation` counter; `startup()` tears down any previous run |
| 10 | MED | Deferred `load` listener was untracked — after shutdown it loaded `nullsrc/engine.js` | listener tracked and removed; `attachToWindow` guards on `rootURI` |
| 12 | MED | `allTokensInTitle` counted weak subsequence hits, giving the bonus to noise | requires a substring-tier match (≥ 0.5) |
| 16 | MED | `Reader.open` was the one unguarded await; a throw made Enter a silent no-op | wrapped, falls through to the documented chain |
| 17 | MED | Every keystroke during a sync triggered a full library re-scan | `REBUILD_MIN_INTERVAL_MS`, serving the slightly stale index in between |
| 18 | MED | IME composition keys were hijacked, making CJK input impossible | `isComposing` / keyCode 229 bail-out |
| 19 | MED | No height budget: a short window clipped the list with no scrollbar | `max-height: 76vh` + flex rules |
| 21 | LOW | `_hasLaunchableURL` was more generous than `viewItems`, so Enter could do nothing | mirrors viewItems' chain exactly (first attachment only) |
| 23 | LOW | An index that legitimately yields zero entries re-scanned on every keystroke | cache check no longer requires a non-empty index |
| 29 | LOW | Fixed 52px rows clipped text at Zotero's larger UI fonts | `min-height`, rows grow instead |
| 30 | LOW | `destroy()` during `init()`'s stylesheet await orphaned the `<style>` | `_initGen` generation check |
| 31 | LOW | `init()` twice registered a second pair of window listeners | `init()` is idempotent |
| 32 | LOW | An unreadable stylesheet left an unstyled full-bleed overlay covering the window | inline fallback CSS keeps it usable and dismissable |
| 34 | LOW | `--material-menu` is translucent, so the PDF bled through the result list | uses the opaque `--color-menu` |

## Verified, no change needed

| # | Sev | Finding | Why |
|---|---|---|---|
| 11 | MED | A synchronous throw in `ensureIndex()`'s IIFE leaves `_building` a rejected promise forever | the `finally` clears `_building` on every path, so the next search rebuilds |

## Deliberately deferred

| # | Sev | Finding | Reason |
|---|---|---|---|
| 13 | MED | `waitForDataLoad('item')` at attach time force-loads data Zotero defers | it is what makes the first Cmd+O instant; revisit if startup feels slow |
| 22 | LOW | `Reader.open` does not fire the `open`/`file` notification, so `attachmentLastRead` is not updated | cosmetic; going through `FileHandlers` instead would forfeit the guaranteed tab |
| 24 | LOW | `_pickReaderAttachment` omits Zotero's parent-URL tiebreak | rare; the synchronous resolution it buys is what keeps the "already open" badge cheap |
| 26 | LOW | Index and observer are per-window: N windows means N copies and N rebuilds | irrelevant at one window; hoisting to a singleton is a real refactor |
| 33 | LOW | Arrow keys are consumed regardless of held modifiers | intentional — it is a list navigator, and Up/Down do nothing useful in a single-line input. `Home`/`End` with Shift/Alt **are** passed through for text selection |

## Not reachable in this build

Pass 1 raised 36 findings, of which 8 survived verification; the rest were refuted by the skeptic
pass. Three of the 8 were already resolved by the rewrite between the two passes, and the remaining
five are in the Fixed table above under their pass-2 equivalents. The 28 refuted ones are recorded
in `REVIEW-FINDINGS.md` with the reasoning that killed them.
