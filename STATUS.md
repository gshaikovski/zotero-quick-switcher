# Where this stands — paused 2026-08-05

**Do not install yet.** The plugin builds and is feature-complete, but a known-better rewrite of two
files is pending and the review found 2 critical defects that are not yet fixed.

## What exists

| File | State |
|---|---|
| `manifest.json` | Done. MV2, `applications.zotero`, https `update_url`, `strict_max_version` `9.*`. Verified loadable on 9.0.6. |
| `bootstrap.js` | Done. Lifecycle hooks; handles the already-open main window `onMainWindowLoad` never fires for. |
| `prefs.js` | Done. Default hotkey `accel+O`. |
| `src/engine.js` | **To be rewritten** — see below. |
| `src/opener.js` | Mostly good; one confirmed finding to address. |
| `src/overlay.js` | **To be rewritten** — see below. |
| `skin/quickSwitcher.css` | Fine, needs reworking for the div-based overlay. |
| `build.sh` | Done. Produces a valid `.xpi` (`manifest.json` at archive root). |
| `SPEC.md` | Implementation spec from the research pass. Authoritative — it overrules the current code. |
| `REVIEW-FINDINGS.md` | 36 findings, 13 confirmed by an independent skeptic pass. |

All JS parses (`node --check`). `./build.sh` produces
`build/zotero-quick-switcher-0.1.0.xpi`.

## The pending rewrite (decided, not yet done)

`SPEC.md` overturned four choices in the current code, each with citations into the shipped Zotero
source. Adopt all four:

1. **Overlay: XUL `<panel>` → `position:fixed` XHTML div** appended to `document.documentElement`.
   A panel "completely takes over Escape" (Zotero's own comment, `xpcom/reader.js:1202-1204`) and on
   macOS is a separate native window whose hide races the `setTimeout` refocus hook in
   `tabs.js:941-944`. `#zotero-tab-cover` (`zoteroPane.xhtml:1101`) proves a fixed div paints over
   the reader. See SPEC §2.1.
2. **CSS: `<link href="jar:…">` → `<style>` text injection** via
   `Zotero.File.getResourceAsync(rootURI + '…')`. This is a real bug today: `<link>` works for an
   unpacked dev install but is unproven for a packed `.xpi` — i.e. it could silently fail in exactly
   the install path the README recommends. See SPEC §2.3.
3. **Hotkey listener: `document` → `window`, capture phase**, and add `stopImmediatePropagation()`.
   ZoteroPane already has a capture listener on `document`; the window is one level higher so we run
   first regardless of registration order. See SPEC §3.1. Also ship the reader-iframe hookup from
   §3.3 behind a pref as insurance.
4. **Search: `Zotero.Search` per keystroke → client-side index.** This buys **true fuzzy matching**
   (`aiayn` → *Attention Is All You Need*), which SQL `LIKE '%token%'` can never do — the current
   README documents that as a limitation, but it is avoidable. Measured library size: 3,013 rows but
   only **~569 real papers** (1,553 are annotations), so an in-memory index is trivial.
   **Mandatory:** `Zotero.Items.getAll(libraryID, true)` leaks annotations — its SQL does not join
   `itemAnnotations` — so filter with `isRegularItem()` explicitly. See SPEC §4.

## Confirmed defects to fix (from REVIEW-FINDINGS.md)

Two critical:

- `src/engine.js` — `getDisplayTitle()` is the only unguarded accessor in `getStrings()`. Since the
  `loadDataTypes()` failure is swallowed, one item with unloaded data throws and kills the **entire**
  search.
- `src/overlay.js` — an in-flight search resumes after `destroy()` and dereferences a null
  `_doc`/`_list`.

Then the confirmed high-severity ones: debounce timer surviving `close()` (stale results land in a
freshly reopened switcher), click reading a stale row index (opens the wrong paper), `_render()`
outside the try/catch desyncing `_results` from the visible list, mousemove overriding the keyboard
selection and breaking the "first result preselected" guarantee, `publicationTitle` needing
`includeBaseMapped`, and `RANK_CAP` truncating in itemID order so the newest matches are dropped.
Several of these disappear with the rewrite; re-check rather than assuming.

## Resuming

Both workflows were stopped cleanly and replay completed agents from cache:

```
Workflow({scriptPath: '…/workflows/scripts/quick-switcher-review-wf_997d759a-785.js',
          resumeFromRunId: 'wf_997d759a-785'})
```

The review had 39/41 agents done, so a resume is nearly free. Re-review after the rewrite, since
most findings target files that are being replaced.

Extracted Zotero 9.0.6 source (ground truth for every API) is at
`/Users/george/.claude/jobs/be8c93f2/tmp/omni`. It is a read-only copy out of
`/Applications/Zotero.app/Contents/Resources/app/omni.ja`; if the job dir is cleaned up, re-extract
with `unzip`. Never write into the app or the Zotero profile.
