# Zotero Quick Switcher — Implementation Spec

**Target:** Zotero 9.0.6 (Gecko 140.12.0), macOS arm64, profile `default` at
`/Users/george/Library/Application Support/Zotero/Profiles/tbdh7sc6.default`.

**Feature:** An Obsidian-Cmd+O-style floating overlay, invokable from any tab (library tab or an
open PDF/EPUB reader tab), that live-searches the library as you type, shows a ranked result list
(10 visible, scrollable beyond), supports arrow-key navigation with the first result preselected,
and on Enter opens the selected paper in a reader tab — switching to its existing tab if one is
already open.

All source citations below are paths relative to `/Users/george/.claude/jobs/be8c93f2/tmp/omni`
(the extracted Zotero 9.0.6 app `omni.ja`) unless prefixed `[gre]`, which means
`/Users/george/.claude/jobs/be8c93f2/tmp/gre-omni` (the extracted toolkit `omni.ja` from
`/Applications/Zotero.app/Contents/Resources/omni.ja`). Every API below was read in the shipping
source during this spec's preparation.

---

## 0. Verified ground truth (resolutions of researcher disagreements)

Three claims were contested across the research passes. All three were re-verified directly:

### 0.1 Do reader-tab key events reach the main chrome window? **YES.** (settled)

One researcher asserted "DOM keydown events fired inside the reader iframe do NOT bubble into the
main window document." That is **wrong**. Three independent proofs from the shipping source:

1. The reader is a **non-remote, in-process** `<browser type="content">` created in the *main
   chrome document* and appended to the tab's `<tab-content>`. There is no `remote` attribute, and
   `docShell` / `contentWindow` are touched synchronously immediately after append — impossible
   across a process boundary.
   `chrome/content/zotero/xpcom/reader.js:1812-1819`

2. `ReaderTab` registers `DOMContentLoaded`, `pointerdown` and `pointerup` listeners **on the chrome
   window** and then inspects targets that live inside the *doubly nested* pdf.js viewer document
   (`event.target.closest('#outerContainer')`, `event.target.ownerDocument.defaultView`). The target
   is **not retargeted** — chrome listeners see the real content node.
   `chrome/content/zotero/xpcom/reader.js:1824-1826, 1880-1896`

3. Decisive: **Cmd-W closes reader tabs.** The XUL route cannot be doing it — `cmd_close` is
   explicitly `disabled` whenever more than one tab is open
   (`chrome/content/zotero/tabs.js:406-407`). The only remaining code path is
   `ZoteroPane.captureKeyDown`, a **capture-phase `keydown` listener on the chrome `document`**
   (`chrome/content/zotero/zoteroPane.js:81`), whose Cmd-W branch is guarded by
   `Zotero_Tabs.selectedIndex > 0` — i.e. it only fires for **non-library** tabs
   (`chrome/content/zotero/zoteroPane.js:927-937`). Same listener implements Cmd-1..9 tab jumping,
   Ctrl-Tab, Cmd-Shift-[ / ], all of which work with a PDF focused.

Because bubble-phase listeners on the chrome window receive reader-content events, the chrome
window is in the event propagation path — therefore **capture-phase listeners on the chrome window
fire first**, before the reader's own capturing listener on the `reader.html` window
(`resource/reader/reader.js:72684-72691`) and before any pdf.js handler.

### 0.2 Is Cmd+O free? **YES.** (verified)

The main window's four keysets (`macKeyset`, `mainKeyset`, `editMenuKeys`, `sortSubmenuKeys`) are
fully enumerated at `chrome/content/zotero/zoteroPane.xhtml:142-216`. No `accel+O`. The only
`accel+O` in the whole application is Scaffold's `<key id="load">`
(`chrome/content/scaffold/scaffold.xhtml:106`), a separate chrome window.

Cmd+**Shift**+O *is* taken (`extensions.zotero.keys.newNote = "O"`,
`defaults/preferences/zotero.js:1656`), so the handler must require `!shiftKey`.

### 0.3 Does a `position: fixed` HTML div paint over the reader `<browser>`? **YES.** (verified)

Zotero's own reader loading cover is exactly that — an **XHTML** `<div id="zotero-tab-cover">`
declared inline in the XUL document (`chrome/content/zotero/zoteroPane.xhtml:1101-1103`) styled
`position: fixed; z-index: 2; height: 100%` (`chrome/skin/default/zotero/overlay.css:137-150`), and
it covers the reader while it loads. Independently, `#zotero-context-pane.stacked` is
`position:fixed` and overlays the reader (`chrome/content/zotero-platform/mac/zotero.css`).

Further confirmation that ordinary CSS stacking governs the reader (not a special compositor layer):
Zotero explicitly *raises* the reader iframe's parent z-index to escape the context pane in Stacked
View — pointless if the reader always painted on top
(`chrome/content/zotero/xpcom/reader.js:571-582`). That bump is `z-index: 1` **inside the tabs-deck
subtree**, so it cannot compete with an element in the root stacking context.

---

## 1. Final decisions: manifest, file layout, bootstrap contract

### 1.1 `manifest.json` (verbatim)

```json
{
  "manifest_version": 2,
  "name": "Quick Switcher",
  "version": "0.1.0",
  "description": "Obsidian-style quick switcher for Zotero: Cmd+O from any tab.",
  "icons": {
    "48": "icons/icon48.png",
    "96": "icons/icon96.png"
  },
  "applications": {
    "zotero": {
      "id": "quick-switcher@zotero-search.local",
      "update_url": "https://example.invalid/quick-switcher/updates.json",
      "strict_min_version": "9.0",
      "strict_max_version": "10.*"
    }
  }
}
```

Hard requirements, all verified in `[gre]/modules/Extension.sys.mjs:1868-1885`:

- `manifest_version` **must be 2**. Under MV3 the WebExtension schema deletes the entire
  `applications` key (`"max_manifest_version": 2` on `WebExtensionManifest.applications` in
  `[gre]/chrome/toolkit/content/extensions/schemas/manifest.json`), after which Zotero's
  required-key check fails and the install is rejected. `browser_specific_settings` is **not** an
  alternative — Zotero sets `manifest.browser_specific_settings = undefined` for
  `type == "extension"` *before* the generic BSS→applications copy runs
  (`[gre]/modules/Extension.sys.mjs:1879` vs `:1899-1906`).
- `applications.zotero.id`, `applications.zotero.update_url` and
  `applications.zotero.strict_max_version` are **all three required**; any missing one calls
  `manifestError()` → `Error("Extension is invalid")` → install fails.
- `update_url` **must start with `https:`** even though we never publish updates.
  `providesUpdatesSecurely = !updateURL || updateURL.startsWith("https:")`; with
  `AddonManager.checkUpdateSecurity` true (default, not overridden by Zotero) a non-https URL makes
  the add-on `appDisabled` (`[gre]/modules/addons/XPIDatabase.sys.mjs:443-445, 2692-2700`). A URL
  that 404s is fine; a non-https one is not.
- **Version range is enforced strictly.** Zotero patched `loadManifestFromWebManifest` to set
  `addon.strictCompatibility = !version.includes("-beta") && !version.includes("-dev") &&
  !version.includes("SOURCE")` (`[gre]/modules/addons/XPIInstall.sys.mjs:506-507`). `Zotero.version`
  is literally `Services.appinfo.version === "9.0.6"` (`chrome/content/zotero/xpcom/zotero.js:233`),
  which contains none of those suffixes ⇒ `strictCompatibility === true` ⇒ `isCompatibleWith()`
  requires **both** `vc.compare(appVersion, minVersion) >= 0` **and**
  `vc.compare(appVersion, maxVersion) <= 0` (`[gre]/modules/addons/XPIDatabase.sys.mjs:565-602`).
  A plugin declaring `strict_max_version: "7.0.*"` is silently `appDisabled` on 9.0.6.
  `"10.*"` is what Better BibTeX 9.0.55 ships and is the safe choice.
- `*` is illegal anywhere in `strict_min_version` (throws;
  `[gre]/modules/addons/XPIInstall.sys.mjs:493-496`).
- **No signing needed.** Zotero ships `xpinstall.signatures.required = false`
  (`defaults/preferences/zotero.js:1462`, overriding the Firefox default set at `:27`), plus
  `extensions.legacy.enabled=true`, `xpinstall.whitelist.required=false`,
  `extensions.blocklist.enabled=false`. Do **not** waste time flipping signature prefs.
- The ID must match `/^(\{GUID\}|[a-z0-9-\._]*\@[a-z0-9-\._]+)$/i`
  (`[gre]/modules/addons/XPIProvider.sys.mjs:201-204`). `quick-switcher@zotero-search.local` matches.

*Widening compatibility later:* `strict_min_version` can be lowered to `"7.0"` — nothing in this
spec uses an API introduced after Zotero 7 — but that is **untested** and should not be claimed
without a runtime check on a Zotero 7 build.

### 1.2 File layout

```
/Users/george/dev/zotero-search/plugin/
├── manifest.json
├── bootstrap.js               # lifecycle only; runs in the Cu.Sandbox
├── prefs.js                   # default prefs (fully-qualified names)
├── icons/
│   ├── icon48.png
│   └── icon96.png
└── lib/
    ├── quickSwitcher.js       # the whole feature; loaded via loadSubScript into a target object
    └── quickSwitcher.css      # read as text at startup, injected as a <style> element
```

Keep it to two real source files. Do **not** ship a `chrome.manifest` (unread by the platform), an
`install.rdf` (dead), a `defaults/preferences/` directory (Zotero reads `prefs.js` in the plugin
**root** — `chrome/content/zotero/xpcom/plugins.js:362-395`), or any `.dtd`/`.properties` files.

Zotero plugins **cannot register `chrome://` URLs**. `aomStartup.registerChrome()` is reachable only
for langpacks (`[gre]/modules/Extension.sys.mjs:4604-4616`). Everything must be addressed through
`rootURI` (`file:///…/` unpacked, `jar:file:///…!/` packed).

`prefs.js` may contain only `pref(name, value)` calls with boolean/string/number values, and names
must be **fully qualified** because it is evaluated against `Services.prefs.getDefaultBranch("")`
(`chrome/content/zotero/xpcom/plugins.js:376-395`):

```js
pref("extensions.zotero.quickSwitcher.maxResults", 50);
pref("extensions.zotero.quickSwitcher.debounceMs", 60);
pref("extensions.zotero.quickSwitcher.hookReaderWindows", true);
pref("extensions.zotero.quickSwitcher.fallback", "library");
```

### 1.3 `bootstrap.js` hook contract

Every hook is invoked as `func.call(scope, params, reason)` where
`params = { id, version, rootURI }` (+ `{ window }` for the two window hooks). There is **no**
`resourceURI` property — that was Firefox's legacy bootstrap.
`rootURI` always ends in `/`. Returned promises **are** awaited. Exceptions are caught and routed to
`Zotero.logError` only — **nothing surfaces in the UI**.
(`chrome/content/zotero/xpcom/plugins.js:224-267`)

Reason constants are injected as bare globals into the sandbox
(`chrome/content/zotero/xpcom/plugins.js:53-64, 160-162`):
`APP_STARTUP:1, APP_SHUTDOWN:2, ADDON_ENABLE:3, ADDON_DISABLE:4, ADDON_INSTALL:5,
ADDON_UNINSTALL:6, ADDON_UPGRADE:7, ADDON_DOWNGRADE:8, MAIN_WINDOW_LOAD:9, MAIN_WINDOW_UNLOAD:10`.

```js
// bootstrap.js — runs in a Cu.Sandbox with the SYSTEM principal.
// Available: Zotero, Services, ChromeUtils, IOUtils, PathUtils, Localization, XMLSerializer,
//            Worker, ChromeWorker, setTimeout/clearTimeout/setInterval/clearInterval,
//            requestIdleCallback/cancelIdleCallback, fetch, DOMParser, URL, TextDecoder, ...
// NOT available: window, document, console, Components, Cc, Ci, Cu.
//            (chrome/content/zotero/xpcom/plugins.js:137-183)

var QuickSwitcher = null;

async function startup({ id, version, rootURI }, reason) {
  // Load the implementation into an explicit target object (NOT the sandbox global).
  // ignoreCache:true so edits take effect on restart during development.
  const scope = {
    Zotero, Services, rootURI, pluginID: id, pluginVersion: version,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestIdleCallback, cancelIdleCallback
  };
  Services.scriptloader.loadSubScriptWithOptions(rootURI + 'lib/quickSwitcher.js', {
    target: scope,
    ignoreCache: true
  });
  QuickSwitcher = scope.QuickSwitcher;

  await QuickSwitcher.init();

  // CRITICAL: onMainWindowLoad is NOT retroactive. The Services.wm listener is added at the very
  // END of Zotero.Plugins.init(), after all startup() calls, so the already-open main window never
  // receives it. (chrome/content/zotero/xpcom/plugins.js:93-124)
  for (let win of Zotero.getMainWindows()) {
    QuickSwitcher.addToWindow(win);
  }
}

function onMainWindowLoad({ window }, reason) {
  // NOTE: the payload is an OBJECT; `window` is a property, not the argument itself.
  QuickSwitcher?.addToWindow(window);
}

function onMainWindowUnload({ window }, reason) {
  // SHIPPING BUG: Zotero passes REASONS.MAIN_WINDOW_LOAD (9) here, not MAIN_WINDOW_UNLOAD (10).
  // (chrome/content/zotero/xpcom/plugins.js:120)  NEVER branch on `reason` in this hook.
  QuickSwitcher?.removeFromWindow(window);
}

function shutdown(params, reason) {
  // shutdown() is NOT preceded by onMainWindowUnload. It must tear down every window itself.
  // (chrome/content/zotero/xpcom/plugins.js:86-91, 717, 771, 780)
  if (!QuickSwitcher) return;
  for (let win of Zotero.getMainWindows()) QuickSwitcher.removeFromWindow(win);
  QuickSwitcher.destroy();
  QuickSwitcher = null;
}

function install(params, reason) {}
function uninstall(params, reason) {}
```

Lifecycle facts the implementer must internalise:

| Fact | Citation |
|---|---|
| `Zotero.Plugins.init()` runs once, at the very end of `Zotero.initComplete()`, **after** `initializationDeferred.resolve()`. The main window already exists when `startup()` runs. | `chrome/content/zotero/xpcom/zotero.js:424-446` |
| APP_STARTUP order per add-on: `_loadScope` → `setDefaultPrefs` → `await registerLocales` → `await startup(APP_STARTUP)`. `install` is **not** called. | `chrome/content/zotero/xpcom/plugins.js:72-84` |
| Window hooks fire **only** for `location.href === "chrome://zotero/content/zoteroPane.xhtml"`. | `chrome/content/zotero/xpcom/plugins.js:98-101, 113-115` |
| Disable→enable does **not** re-run `bootstrap.js`. `_loadScope` early-returns if the scope exists; `_unloadScope` only runs on uninstall/upgrade. Module-level state survives. Make `startup()` idempotent. | `chrome/content/zotero/xpcom/plugins.js:133-135, 755-774` |
| A missing hook is a `Zotero.warn`, not an error — a typo in `onMainWindowLoad` fails silently. | `chrome/content/zotero/xpcom/plugins.js:243-246` |
| `ChromeUtils.import()` is only a deprecation-warning Proxy in the plugin scope. Use `importESModule()` — or, for our own code, `loadSubScript`. | `chrome/content/zotero/xpcom/plugins.js:185-199` |

---

## 2. The overlay UI

### 2.1 Decision: **XHTML `<div>` appended to `document.documentElement`, `position: fixed`**

Not a XUL `<panel>`.

**Reasoning.** Both work. The panel gives free rollup and widget-level z-order; the div gives
control. Four things decide it for the div:

1. **Focus.** `Zotero_Tabs.select()` snapshots `document.activeElement` as the library tab's
   `lastFocusedElement` (`chrome/content/zotero/tabs.js:911-916`) and then fires the per-type
   `refocus` hook on a `setTimeout(…, 0)` (`chrome/content/zotero/tabs.js:941-944`). Enter must
   therefore hide the overlay *before* selecting a tab. With a div, hiding is a synchronous
   `display:none` + `.blur()` in the same document — deterministic. With a `<panel>` on macOS the
   popup is a **separate native window**, so hiding it triggers an OS-level key-window transfer that
   races the `setTimeout` refocus hook.
2. **Escape.** `<panel>` "completely takes over Escape keydown event, by attaching a capturing
   keydown listener to document which just closes the popup" — Zotero's own verbatim comment at
   `chrome/content/zotero/xpcom/reader.js:1202-1204`, where they had to work around it. We want
   full control of Escape (clear-then-close).
3. **Styling.** An Obsidian-style centered modal with a dim backdrop is trivial with a div and
   awkward inside a panel's `::part(content)`.
4. **Precedent.** `#zotero-tab-cover` (`chrome/content/zotero/zoteroPane.xhtml:1101` +
   `chrome/skin/default/zotero/overlay.css:137-150`) is exactly this construct and demonstrably
   paints over and blocks input to the reader `<browser>`. `guidancePanel.js:161-181` appends a
   `position:fixed` HTML div straight to `document.documentElement` of this XUL window.

**Fallback if the div fails to paint over the reader** (probe it — see §9): switch to
`document.createXULElement('panel')` appended to the global `<popupset>`
(`document.querySelector('popupset')`, `chrome/content/zotero/zoteroPane.xhtml:931`; Zotero reaches
it the same way at `chrome/content/zotero/tabs.js:1163-1164`), opened with
`panel.openPopup(null, 'before_start', x, y, false, false)`. The internal markup and all the
search/rank/keyboard logic are unchanged.

**Do not** put anything inside a `<tab-content>`: `Zotero_Tabs.select()` calls `hidePopup()` on every
`panel, menupopup` under `this.deck.selectedPanel` on every tab switch
(`chrome/content/zotero/tabs.js:889-899`), and unselected deck panels are only visually hidden
(`#tabs-deck>:not(.deck-selected){-moz-subtree-hidden-only-visually:1}`).

### 2.2 Exact DOM

In this document `document.createElement()` yields **XHTML** elements — proven by Zotero calling
`.rel` on `createElement("link")` (`chrome/content/zotero/elements/quickSearchTextbox.js:72-74`) and
`.classList/.dataset/.role` on `createElement('div')`
(`chrome/content/zotero/elements/tabsMenuPanel.js:134-146`). `document.createXULElement()` is
required only for XUL widgets — we need none.

```
<div id="qs-overlay" hidden>                     ← position:fixed; inset:0; z-index:2147483000
  <div id="qs-backdrop"></div>                   ← click → close
  <div id="qs-modal" role="combobox" aria-expanded="true" aria-owns="qs-list">
    <input id="qs-input" type="text" autocomplete="off" spellcheck="false"
           aria-controls="qs-list" aria-activedescendant="qs-row-0"/>
    <div id="qs-list" role="listbox"></div>      ← max-height = 10 rows; overflow-y:auto
    <div id="qs-empty" hidden>No results</div>
    <div id="qs-hint">↑↓ navigate · ⏎ open · ⇧⏎ reveal in library · esc close</div>
  </div>
</div>
```

Each row:

```
<div class="qs-row" role="option" id="qs-row-N" data-item-id="123">
  <img class="qs-icon" src="…"/>                 ← Zotero.ItemTypes.getImageSrc(item.getItemTypeIconName())
  <div class="qs-main">
    <div class="qs-title">…<b>matched</b>…</div>
    <div class="qs-meta">Firstcreator · 2019 · Journal Name</div>
  </div>
  <span class="qs-badge" hidden>open</span>      ← shown if a tab already exists for this item
</div>
```

Attach: `win.document.documentElement.appendChild(root)`. `position: fixed` takes the element out of
flow, so it will not perturb the `<window style="display:flex">` layout.

Row height is fixed in CSS (`--qs-row-h: 46px`) so "10 visible" is exact:
`#qs-list { max-height: calc(var(--qs-row-h) * 10); overflow-y: auto; scrollbar-width: thin; }`.

### 2.3 CSS injection

Ship `lib/quickSwitcher.css` as a real file, read it **as text** once at `init()` with
`await Zotero.File.getResourceAsync(rootURI + 'lib/quickSwitcher.css')`
(`chrome/content/zotero/xpcom/file.js:361`), and inject per window as a `<style>` element:

```js
const style = doc.createElement('style');       // XHTML <style>
style.id = 'qs-stylesheet';
style.textContent = CSS_TEXT;
doc.documentElement.appendChild(style);         // == doc.children[0]
```

This is exactly Zotero's own runtime-CSS pattern (`document.createElement('style')` appended to
`document.children[0]`, then driven with `.sheet.insertRule()`) at
`chrome/content/zotero/components/virtualized-table.js:1543-1550`.

Why text-injection rather than `<link rel="stylesheet" href="${rootURI}…">`:
a `<link>` works for an unpacked dev install (`file:///`) but is unproven for a packed `.xpi`
(`jar:file:///…!/`). Text injection is scheme-agnostic, works packed or unpacked, and removes with a
single `.remove()`.

Why not the `<?xml-stylesheet?>` processing-instruction route Zotero uses for plugin preference
panes (`chrome/content/zotero/preferences/preferences.js:323-330`): it inserts **before**
`document.firstChild`, i.e. *ahead* of the five built-in stylesheet PIs at
`chrome/content/zotero/zoteroPane.xhtml:28-33`, so it **loses** cascade ties. Our `<style>` appended
to `documentElement` comes last in document order and wins.

### 2.4 Theming

Zotero defines all theme tokens on `:root` (which is `<window id="main-window">`) with a
`prefers-color-scheme` block, in `chrome/content/zotero-platform/mac/zotero.css`. Verified present:

```
:root { font-family: system-ui, -apple-system, sans-serif; font-size: 13px; line-height: 1.3333; }
--material-background  --material-menu     --material-toolbar   --material-sidepane
--material-border      --material-border50 --material-background50/70
--fill-primary  --fill-secondary  --fill-tertiary  --fill-quarternary  --fill-quinary  --fill-senary
--color-accent  --color-accent-text  --color-focus-border  --color-scrollbar  --color-scrollbar-hover
```

Use these exclusively; do not hardcode colours. Suggested mapping:

| Element | Token |
|---|---|
| modal background | `var(--material-menu)` |
| modal border | `1px solid var(--fill-quarternary)` |
| backdrop | `rgba(0,0,0,0.28)` (no token; acceptable) |
| title text | `var(--fill-primary)` |
| meta text | `var(--fill-secondary)` |
| selected row bg | `var(--color-accent)` with `color: var(--color-accent-text)` |
| hover row bg | `var(--fill-quinary)` (matches `#zotero-tabs-menu-list .row:hover`) |
| input focus ring | `var(--color-focus-border)` |

---

## 3. Hotkey capture

### 3.1 Primary: capture-phase `keydown` on the chrome **window**

```js
function makeKeyHandler(win) {
  return function onKeyDown(event) {
    const accel = Zotero.isMac ? event.metaKey : event.ctrlKey;
    // Require accel ONLY — Cmd+Shift+O is Zotero's newNote (defaults/preferences/zotero.js:1656)
    if (!accel || event.shiftKey || event.altKey) return;
    if (Zotero.isMac ? event.ctrlKey : event.metaKey) return;
    // event.code is layout-independent; event.key is uppercased when Shift is held
    if (event.code !== 'KeyO') return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    QuickSwitcher.toggle(win);
  };
}

// in addToWindow(win):
const keyHandler = makeKeyHandler(win);
win.addEventListener('keydown', keyHandler, true);   // CAPTURE, on the WINDOW
```

Why `window` and not `document`: `ZoteroPane` already has a capture listener on `document`
(`chrome/content/zotero/zoteroPane.js:81`); the window is one level higher in the capture chain, so
we run first regardless of registration order.

Why capture and not bubble: the reader `stopPropagation()`s several combos
(Cmd+P print `resource/reader/reader.js:72934-72937`, Cmd+G / Cmd+Shift+G, Cmd+±/0), so a
bubble-phase listener can be silently swallowed. Capture at the chrome window runs before the
reader's own capturing listener on the `reader.html` window
(`resource/reader/reader.js:72684-72691`).

Why `preventDefault()` **and** `stopPropagation()`: `preventDefault` alone still lets other
default-group listeners run; `stopPropagation` alone still lets system-group XUL `<key>` handlers
run. This is Zotero's own idiom (`chrome/content/zotero/zoteroPane.js:932-933`,
`chrome/content/zotero/platformKeys.js:135-141`). The reader's inner views additionally bail on
`event.defaultPrevented` (`resource/reader/reader.js:60876-60879`).

### 3.2 Why NOT a XUL `<key>` in a `<keyset>`

XUL key handling runs in the **system event group**, i.e. after all default-group listeners over the
whole propagation chain, and is skipped for already-`defaultPrevented` events. In-source evidence:
the reader `preventDefault()`s Cmd+F (`resource/reader/reader.js:72916`) while the same window still
has `<key id="key_find" … command="cmd_find">` pointing at the library quick-search
(`chrome/content/zotero/zoteroPane.xhtml:196`) — the reader wins, which only makes sense if `<key>`
runs later and honours `defaultPrevented`. Second reason: Zotero's own comment at
`chrome/content/zotero/zoteroPane.xhtml:203-204` warns that `<key>` elements "don't work on Windows
if they're created in JS".

### 3.3 Defensive reader-iframe hookup (ship it, behind a pref)

§0.1 establishes the chrome-window listener should be sufficient. Ship a belt-and-braces layer
anyway — it costs ~30 lines, is idempotent, and de-risks the single biggest unknown. Gate it on
`extensions.zotero.quickSwitcher.hookReaderWindows` (default `true`); if the runtime probe in §9.1
shows the chrome listener alone works, flip the default to `false`.

```js
const READER_HOOK_FLAG = '__quickSwitcherHooked';

// Attach the same handler to a reader's inner windows, once each.
function hookReaderWindows(win, reader) {
  const h = state.get(win)?.keyHandler;
  if (!h || !reader) return;

  const attach = (w) => {
    if (!w || w[READER_HOOK_FLAG]) return;
    try {
      w.addEventListener('keydown', h, true);
      w[READER_HOOK_FLAG] = true;
      state.get(win).hookedReaderWindows.add(Cu ? w : w);  // keep for teardown
    } catch (e) { Zotero.debug('[quick-switcher] reader hook failed: ' + e); }
  };

  // 1) reader.html shell window                (chrome/content/zotero/xpcom/reader.js:1881-1883)
  attach(reader._iframeWindow);
  // 2) the nested pdf.js / EPUB view window    (resource/reader/reader.js: view._iframeWindow)
  try { attach(reader._internalReader?._primaryView?._iframeWindow); } catch (e) {}
}

async function hookAllReaders(win) {
  for (let r of Zotero.Reader._readers || []) {
    try { await r._initPromise; } catch (e) { continue; }   // reader.js:57-60
    if (r._window === win || !r._window) hookReaderWindows(win, r);
  }
}
```

Trigger points (all verified):

- At `addToWindow(win)`: call `hookAllReaders(win)` for readers already open.
- On the Notifier `tab` **`load`** event — fired by `markAsLoaded()`
  (`chrome/content/zotero/tabs.js:1006`); at that point `Zotero.Reader.getByTabID(tabID)`
  (`chrome/content/zotero/xpcom/reader.js:2676-2678`) returns the `ReaderTab` and
  `reader._initPromise` has resolved.
- On the Notifier `tab` **`select`** event, when `extraData[id].type` starts with `reader`
  (`chrome/content/zotero/tabs.js:937`). Selecting an unloaded tab triggers the `load` hook, so
  `select` alone is not enough — handle both; the `__quickSwitcherHooked` flag makes it idempotent.

```js
notifierID = Zotero.Notifier.registerObserver({
  notify(event, type, ids, extraData) {
    if (type === 'tab' && (event === 'load' || event === 'select')) {
      for (let id of ids) {
        const reader = Zotero.Reader.getByTabID(id);
        if (reader) hookReaderWindows(reader._window, reader);
      }
    }
  }
}, ['tab'], 'quick-switcher-tabs');
```

`Zotero.Notifier.registerObserver(ref, types, id, priority) → String hash`; unregister with
`Zotero.Notifier.unregisterObserver(hash)` (`chrome/content/zotero/xpcom/notifier.js:61-110`).
`'tab'` is a valid type (`chrome/content/zotero/xpcom/notifier.js:52`). Observers are **global to
the Zotero singleton**, not per-window — register once in `init()`, unregister in `destroy()`.

**Do not** use `Zotero.Reader.registerEventListener()` for this. It exists
(`chrome/content/zotero/xpcom/reader.js:2549`) but only supports UI-injection points
(`renderTextSelectionPopup`, `renderSidebarAnnotationHeader`, `renderToolbar`, `create*ContextMenu`)
— no key events. Also note its companion `unregisterEventListener` is **buggy in 9.0.6**: it
`filter`s to *keep* the matching listener instead of removing it
(`chrome/content/zotero/xpcom/reader.js:2557`), so registrations there are effectively permanent.

### 3.4 Popped-out reader windows (out of scope for v1)

A reader opened via "Move to New Window" is a **separate top-level XUL window** at
`chrome://zotero/content/reader.xhtml` with `windowtype="zotero:reader"`
(`chrome/content/zotero/xpcom/reader.js:2005-2007`, `chrome/content/zotero/reader.xhtml:14-16`).
`onMainWindowLoad` never fires for it (`chrome/content/zotero/xpcom/plugins.js:98-101`). v1 does not
support the hotkey there. If needed later, add a `Services.wm.addListener` for that window type.

---

## 4. Search and ranking

### 4.1 Decision: **client-side index + client-side ranking.** Do not call `Zotero.Search` per keystroke.

`Zotero.Search.prototype.search()` returns a bare `Integer[]` of itemIDs from
`Zotero.DB.columnQueryAsync(this._sql, …)`. There is **no `ORDER BY` anywhere** in `search.js` and no
score column (`chrome/content/zotero/xpcom/data/search.js:535-541, 639, 824-831`). IDs come back in
SQLite natural (rowid) order. It can also return **duplicates** — Zotero's own local API wraps it in
`[...new Set(...)]` with a `TODO: Fix in search.js` comment
(`chrome/content/zotero/xpcom/server/server_localAPI.js:665-667`).

So ranking must be client-side regardless. Zotero's own citation dialog does exactly that: run
`quicksearch-titleCreatorYear`, `Zotero.Items.getAsync`, `Zotero.Items.loadDataTypes`, then filter
and sort in JS (`chrome/content/zotero/integration/citationDialog/searchHandler.mjs:308-339,
409-490`).

Given that, `Zotero.Search` buys us nothing but latency and semantics we don't want (its multi-word
behaviour is cross-field AND with per-field OR — "deep learning" matches an item whose *title* has
"deep" and whose *creator* is "Learning", `chrome/content/zotero/xpcom/data/search.js:1774-1829`;
`contains` compiles to `LIKE '%v%'` so it cannot do prefix or subsequence matching at all,
`chrome/content/zotero/xpcom/data/search.js:1644-1658`).

**Measured scale for this library** (read from a copy of `~/Zotero/zotero.sqlite.bak`):

| | count |
|---|---|
| rows in `items` | 3,013 |
| `itemAnnotations` | 1,553 |
| `itemNotes` | 328 |
| `itemAttachments` | 562 |
| what `getAll(libraryID, true)` returns | 2,127 |
| **indexable regular top-level items** | **~569** |
| libraries | 1 (My Library; no groups) |

A 569-entry in-memory index is nothing. The design below stays linear and is fine to ~100k entries
with the two-pass prefilter in §4.4.

### 4.2 Index construction

```js
async function buildIndex() {
  const entries = new Map();                       // itemID -> Entry
  for (let lib of Zotero.Libraries.getAll()) {
    if (lib.libraryType === 'feed') continue;      // feeds are noise for a paper switcher
    await lib.waitForDataLoad('item');             // xpcom/data/library.js:407-419
    const ids = await Zotero.Items.getAll(lib.libraryID, true, false, true);   // asIDs
    const items = await Zotero.Items.getAsync(ids);
    await Zotero.Items.loadDataTypes(items);       // xpcom/data/dataObjects.js:450
    for (let item of items) {
      const e = makeEntry(item);
      if (e) entries.set(item.id, e);
    }
  }
  return entries;
}
```

`Zotero.Items.getAll(libraryID, onlyTopLevel, includeDeleted, asIDs)` is async and verified at
`chrome/content/zotero/xpcom/data/items.js:112-140`. It excludes trashed items
(`NOT IN (SELECT itemID FROM deletedItems)`).

**Mandatory filter:** `getAll(…, onlyTopLevel=true)` only `LEFT JOIN`s `itemNotes` and
`itemAttachments`, so **annotations pass the top-level test** — 1,553 of the 2,127 rows here. Filter
explicitly:

```js
function makeEntry(item) {
  const isStandaloneAtt = item.isAttachment() && !item.parentID && item.attachmentReaderType;
  if (!item.isRegularItem() && !isStandaloneAtt) return null;   // drops notes + annotations
  …
}
```

`item.parentID` is `false` (not null) when there is no parent
(`chrome/content/zotero/xpcom/data/dataObject.js:29-33`) — use truthiness.

**Entry shape** (all accessors below are **synchronous** and verified):

```js
{
  id,                                  // Number
  itemType,      // item.itemType     — xpcom/data/item.js:140-145
  title,         // item.getDisplayTitle() || item.getField('title')
  titleN,        // normalize(title)
  sortTitleN,    // normalize(Zotero.Items.getSortTitle(title))   items.js:1599-1612
  creatorsN,     // [normalize(lastName), …] from item.getCreators()   item.js:1135-1161
  creatorFullN,  // [normalize(first + ' ' + last), …]
  firstCreatorN, // normalize(item.getField('firstCreator', true))  ← unformatted strips U+2068/2069
  year,          // item.getField('year')  → getField('date',true,true).substr(0,4)  item.js:259-261
  pubN,          // normalize(item.getField('publicationTitle'))
  citeKeyN,      // normalize(item.getField('citationKey'))
  haystack,      // titleN + ' ' + firstCreatorN + ' ' + creatorsN.join(' ') + ' ' + year
                 //   + ' ' + pubN + ' ' + citeKeyN     (prefilter only)
  attachmentID,  // Number|null — resolved SYNCHRONOUSLY, see §4.3
  readerType,    // 'pdf'|'epub'|'snapshot'|null
  dateModified   // item.dateModified — tie-break
}
```

Caveats verified in source:

- `item.getDisplayTitle(includeAuthorAndDate)` **ignores its argument** in 9.0.6 — it just returns
  the cached `_displayTitle` (`chrome/content/zotero/xpcom/data/item.js:885-897`). Concatenate
  creator/year yourself for the meta line.
- `item.firstCreator` embeds Unicode bidi isolates `⁨`/`⁩` in the two-author case
  (`chrome/content/zotero/xpcom/data/items.js:1492-1494`). `getField('firstCreator', true)` strips
  them (`chrome/content/zotero/xpcom/data/item.js:253-256`) — always pass `unformatted = true`.
- `getField()` throws `UnloadedDataException` if `itemData` isn't loaded; `getCreators()` needs
  `creators`; `getAttachments()` needs `childItems`. `loadDataTypes(items)` with no `dataTypes`
  argument loads **all** types (`chrome/content/zotero/xpcom/data/dataObjects.js:450-452`), which
  covers all three.
- `Zotero.Libraries.userLibraryID` **throws** "Library data not yet loaded" if read too early
  (`chrome/content/zotero/xpcom/data/libraries.js:26-41`). Never touch it at sandbox top level.

**When to build:** lazily. Kick it off from `init()` inside `requestIdleCallback`, and `await` the
same promise on the first `toggle()` so an early Cmd+O still works. Do not block `startup()`.

### 4.3 Synchronous best-reader-attachment resolution

`item.getBestAttachment()` is **async** and issues a SQL query per item
(`chrome/content/zotero/xpcom/data/item.js:4019-4060`) — 569 awaits at index build is wasteful, and
we need the attachment id *synchronously* to render the "already open" badge. Reproduce its ordering
in memory:

```js
const READER_RANK = { pdf: 0, epub: 1, snapshot: 2 };

function pickReaderAttachment(item) {
  if (item.isAttachment()) return item.attachmentReaderType ? item : null;
  if (!item.isRegularItem()) return null;
  if (!item.numAttachments()) return null;                      // item.js:2585
  const atts = Zotero.Items.get(item.getAttachments(false));    // SYNC, excludes trashed; item.js:3977
  const openable = atts.filter(a => a && a.attachmentReaderType); // item.js:3264-3280
  if (!openable.length) return null;
  const url = item.getField('url');
  openable.sort((a, b) =>
       (READER_RANK[a.attachmentReaderType] - READER_RANK[b.attachmentReaderType])
    || ((b.getField('url') === url) - (a.getField('url') === url))
    || (a.dateAdded < b.dateAdded ? -1 : a.dateAdded > b.dateAdded ? 1 : 0));
  return openable[0];
}
```

This mirrors `getBestAttachments()`'s
`ORDER BY contentType='application/pdf' DESC, value=<parent url> DESC, dateAdded ASC`
(`chrome/content/zotero/xpcom/data/item.js:4051-4057`) but additionally **restricts to
reader-openable types** — `getBestAttachment()` does not, so a `.docx` or image can be its "best"
(which would launch an external app, not a tab). We deliberately diverge; see §6 for the fallback.

`item.getAttachments(includeTrashed)` throws if called on an attachment
(`chrome/content/zotero/xpcom/data/item.js:3979-3981`) — the `isAttachment()` early return above
handles that.

`Zotero.Items.get(ids)` is synchronous and throws `UnloadedDataException` for registered-but-unloaded
items (`chrome/content/zotero/xpcom/data/dataObjects.js:96-140`); the `waitForDataLoad('item')` in
`buildIndex()` guarantees they're loaded. Wrap `makeEntry` in try/catch anyway and skip on error.

### 4.4 Query processing and scoring

**Normalisation** (applied to both index fields and query):

```js
function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip combining marks: "Müller" → "muller"
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();
}
```

This also fixes a real Zotero limitation: SQLite `LIKE` is case-insensitive for ASCII only, so
`Zotero.Search`'s `contains` cannot match "MULLER" against "Müller". Ours can.

**Tokenisation:** `normalize(query).trim().split(/\s+/).filter(Boolean)`. Support `"quoted phrases"`
as single tokens (mirrors `Zotero.SearchConditions.parseSearchString`,
`chrome/content/zotero/xpcom/data/searchConditions.js:785-810`) — optional for v1.

Minimum query length: **1** for the first pass but see the token-length rule below. Debounce
**60 ms** (Zotero's own quick-search box uses `timeout="250"` —
`chrome/content/zotero/zoteroPane.xhtml:1357` — but that debounces a DB round-trip; an in-memory
scan can be far tighter).

**Per-(field, token) match score** — first rule that fires wins:

| Match kind | Score | Rule |
|---|---:|---|
| exact field equality | 100 | `F === t` |
| field prefix | 90 | `F.startsWith(t)` |
| word-boundary prefix | 75 | some word of `F` starts with `t` (precompute word starts, or `RegExp('(^\|[^a-z0-9])' + esc(t))`) |
| substring | 50 | `F.includes(t)` — only if `t.length >= 2` |
| subsequence | 0–25 | `25 × density`, see below — only if `t.length >= 3` |
| no match | 0 | |

```js
function subsequenceScore(F, t) {
  let from = 0, first = -1, last = -1;
  for (const ch of t) {
    const i = F.indexOf(ch, from);
    if (i === -1) return 0;
    if (first === -1) first = i;
    last = i; from = i + 1;
  }
  const density = t.length / (last - first + 1);   // 1.0 == contiguous
  return 25 * density;                             // strictly below `substring`
}
```

Tokens of length 1 only qualify for prefix / word-boundary-prefix — otherwise a single character
matches nearly every item. (Zotero's citation dialog similarly enforces a minimum query length,
`chrome/content/zotero/integration/citationDialog/searchHandler.mjs:250-252`.)

**Field weights** (title dominates, creator close behind, everything else secondary):

| Field | Weight |
|---|---:|
| `titleN` | **1.00** |
| `creatorsN` (last names, best over all creators) | **0.85** |
| `firstCreatorN` | 0.80 |
| `creatorFullN` (first+last, best over all) | 0.70 |
| `year` (exact 4-digit equality only) | 0.60 |
| `citeKeyN` | 0.55 |
| `pubN` | 0.40 |

`tokenScore(entry, t) = max over fields of (matchScore(field, t) × weight)`.

**AND semantics:** if any token scores `0`, the item is rejected. This matches Zotero's own
"every typed word must match" filter
(`chrome/content/zotero/integration/citationDialog/searchHandler.mjs:441-443`).

**Item score:**

```
base   = Σ over tokens of tokenScore
bonus  = 40  if titleN.startsWith(fullQueryN)
       + 20  if titleN contains fullQueryN as a substring (and not the above)
       + 15  if EVERY token's best match came from titleN (coherence)
       + 12  if titleN word-boundary-prefix-matches every token in order
       +  6  if entry.readerType === 'pdf'      (openable-in-a-tab nudge, deliberately small)
score  = base + bonus
```

**Tie-break** (stable, in order):
1. `score` descending
2. `titleN.startsWith(fullQueryN)` true first
3. `dateModified` descending (recently touched papers first)
4. `sortTitleN` ascending, via `Zotero.getLocaleCollation().compareString(1, a, b)`

**Two-pass prefilter for large libraries:**

```
Pass 1 (strict): keep entries where every token is a substring of entry.haystack.
                 One indexOf per token per entry — very fast.
Pass 2 (fuzzy):  only if pass 1 yields fewer than 10 survivors, rescan the full set allowing
                 subsequence matching.
```

Score only the survivors. Cap the rendered list at `maxResults` (default 50 — see §5).

**Incremental typing optimisation:** if the new query starts with the previous query and the
previous pass-1 survivor set was non-empty, re-run pass 1 over that set only. Reset on backspace or
on any index mutation.

### 4.5 Cache invalidation

```js
notifierID = Zotero.Notifier.registerObserver({
  notify(event, type, ids, extraData) {
    if (type === 'tab') { /* §3.3 reader hookup + refresh open-badges */ return; }
    if (type !== 'item') return;
    if (!['add', 'modify', 'delete', 'trash', 'refresh'].includes(event)) return;
    for (let id of ids) staleIDs.add(parseInt(id, 10));
    scheduleRefresh();      // debounce 1000 ms
  }
}, ['item', 'tab'], 'quick-switcher');
```

Verified: `'item'` and `'tab'` are both valid types
(`chrome/content/zotero/xpcom/notifier.js:33-55`); an invalid type **throws**
(`chrome/content/zotero/xpcom/notifier.js:70-77`). Item events observed in the shipping source:
`'delete'` (`chrome/content/zotero/xpcom/data/dataObject.js:1355-1361`), `'trash'`
(`chrome/content/zotero/xpcom/data/items.js:993, 1051`;
`chrome/content/zotero/xpcom/data/item.js:1803`), plus the generic `'add'`/`'modify'`/`'refresh'`
from the DataObject save path.

`refreshStale()` is unified and needs no per-event logic:

```js
function refreshStale() {
  for (const id of staleIDs) {
    const item = Zotero.Items.get(id);              // false for deleted ids
    const e = (item && !item.deleted) ? makeEntry(item) : null;
    if (e) index.set(id, e); else index.delete(id);
  }
  staleIDs.clear();
  queryCache.clear();                                // memo of last query → results
}
```

A **child-attachment** change (add/remove a PDF) fires an `item` event for the *attachment's* id,
not the parent's. Also add the parent: `if (item && item.parentID) staleIDs.add(item.parentID)`.

If `staleIDs.size > 500` (bulk sync, big import), drop the whole index and rebuild lazily on next
open — cheaper and simpler than 500 individual refreshes.

Debounce at 1000 ms so a sync storm coalesces. Nothing here runs on the render path.

---

## 5. Result-list behaviour

| Aspect | Decision |
|---|---|
| Visible rows | Exactly **10**. Fixed row height `--qs-row-h: 46px`; `#qs-list { max-height: calc(var(--qs-row-h) * 10); overflow-y: auto; }` |
| Rendered rows | Up to `maxResults` (default **50**), all in the DOM, scrollable. 50 × 46 px is trivial — no virtualization. Do **not** pull in `components/virtualized-table.js` (React, overkill; `chrome/content/zotero/elements/tabsMenuPanel.js:134-210` renders a plain `createElement('div')` row list and is the right model). |
| Initial selection | Index **0** preselected on every render. |
| ArrowDown / ArrowUp | Move selection by 1, **with wrap-around** (down at last → first; up at first → last). Matches the Obsidian model the user specified. One-liner to change: `i = (i + d + n) % n` → `i = Math.max(0, Math.min(n - 1, i + d))`. |
| PageDown / PageUp | ±10, clamped (no wrap). |
| Home / End | First / last. |
| Ctrl+N / Ctrl+P | Aliases for down / up (emacs habit; free — the reader claims neither at chrome level). |
| Scroll follow | `row.scrollIntoView({ block: 'nearest' })` after every selection change. |
| Mouse | `mousemove` on a row sets selection (no scroll); `click` activates. Use `mousedown` `preventDefault()` on rows so the input never loses focus. |
| Re-query | Selection resets to 0 whenever the result set changes. |
| Empty query | Show the **10 most recently modified** indexed items (a useful "recent papers" default) rather than an empty list. |
| No results | Show `#qs-empty`; Enter is a no-op. |
| Escape | If the input is non-empty → clear it and re-render. If already empty → close. (Two-stage Escape; needs the div overlay, since `<panel>` swallows Escape — `chrome/content/zotero/xpcom/reader.js:1202-1204`.) |
| Toggle | Cmd+O while open **closes** it (Obsidian behaviour). |
| Outside click | Closes. |
| Highlighting | Bold matched substrings in the title, as `chrome/content/zotero/elements/tabsMenuPanel.js:481-513` does with `Zotero.Utilities.quotemeta`. Build with `createTextNode` + `<b>`; never `innerHTML`. |
| "Already open" badge | `win.Zotero_Tabs.getTabIDByItemID(entry.attachmentID)` — synchronous, returns `id \| undefined` (`chrome/content/zotero/tabs.js:524-527`). Note it takes the **attachment's** id, not the parent's. |

---

## 6. Enter behaviour

### 6.1 Decision: call `Zotero.Reader.open()` directly; do **not** route through `ZoteroPane.viewItems`

`ZoteroPane.viewItems()` → `viewAttachment()` → `Zotero.FileHandlers.open()`, which consults
`Zotero.Prefs.get('fileHandler.' + readerType)` and, if the user configured an external PDF app,
launches that instead of opening a Zotero tab
(`chrome/content/zotero/xpcom/fileHandlers.js:29-57`). It also honours
`openReaderInNewWindow`. The stated requirement is "opens the selected paper in a new **tab**", so
we bypass that layer. Defaults are `fileHandler.pdf/.epub/.snapshot = ""` and
`openReaderInNewWindow = false` (`defaults/preferences/zotero.js:1764-1767`), so for a default
profile the behaviour is identical anyway.

### 6.2 Already-open detection is **free**

`Zotero.Reader.open(itemID, location, opts)` does its own two-stage detection when `allowDuplicate`
is falsy (`chrome/content/zotero/xpcom/reader.js:2697-2740`, read verbatim during verification):

- **Stage 1** — no live reader for `itemID`: `win.Zotero_Tabs.getTabIDByItemID(itemID)`; if found
  (an *unloaded* reader tab) it calls `win.Zotero_Tabs.select(existingTabID, false, { location })`
  and **returns `undefined`**.
- **Stage 2** — otherwise `this._readers.find(r => r.itemID === itemID)`; if that is a `ReaderTab`
  it calls `reader._window.Zotero_Tabs.select(reader.tabID, true)` and returns the reader.

So no duplicate tab is ever created and we need no switching logic of our own. We use
`getTabIDByItemID` only to render the badge.

### 6.3 Exact sequence

```js
async function activate(win, entry, { reveal = false, background = false } = {}) {
  // 1. Hide the overlay FIRST. Zotero_Tabs.select() snapshots document.activeElement as the
  //    library tab's lastFocusedElement (tabs.js:911-916) and fires the type's `refocus` hook on
  //    setTimeout(…, 0) (tabs.js:941-944). Anything focused after select() is stolen a tick later.
  hide(win);

  const item = Zotero.Items.get(entry.id);
  if (!item) return;                                  // closed/deleted between render and Enter

  if (reveal) return revealInLibrary(win, item);

  // 2. Resolve the reader-openable attachment (sync; §4.3). Re-resolve rather than trusting the
  //    cached id, in case an attachment was added/removed since the index entry was built.
  const att = pickReaderAttachment(item);

  if (att) {
    // 3. Reader.open handles BOTH "switch to existing tab" and "create new tab".
    //    allowDuplicate omitted ⇒ falsy ⇒ detection runs.
    //    Returns `undefined` when it switched to an existing UNLOADED tab — NEVER dereference it.
    await Zotero.Reader.open(att.id, null, { openInBackground: background });
    return;
  }

  // 4. No reader-openable attachment.
  const mode = Zotero.Prefs.get('extensions.zotero.quickSwitcher.fallback', true) || 'library';
  if (mode === 'viewItems' && item.isRegularItem()) {
    // Mirror double-click: external app for a .docx, else url/DOI in the browser.
    // NOTE: if the item has no attachment AND no url AND no DOI, viewItems does NOTHING —
    // no error, no message (zoteroPane.js:5044-5068). Hence the reveal fallthrough below.
    await win.ZoteroPane.viewItems([item]);
    if (item.numAttachments() || item.getField('url') || item.getField('DOI')) return;
  }
  return revealInLibrary(win, item);
}

async function revealInLibrary(win, item) {
  // selectItems() itself calls Zotero_Tabs.select('zotero-pane', …) unless noTabSwitch
  // (zoteroPane.js:3138-3140), but select it explicitly first so the switch is immediate.
  win.Zotero_Tabs.select('zotero-pane');
  await win.ZoteroPane.selectItem(item.id);          // async; zoteroPane.js:3099-3104
}
```

### 6.4 Key bindings on the result list

| Key | Action |
|---|---|
| `Enter` | `activate(win, entry)` — open reader tab / switch to existing |
| `Shift+Enter` | `activate(win, entry, { reveal: true })` — switch to library tab and select the item |
| `Cmd/Ctrl+Enter` | `activate(win, entry, { background: true })` — open the tab without focusing it |

`openInBackground: true` suppresses `reader.focus()` at the end of `Reader.open`
(`chrome/content/zotero/xpcom/reader.js:2786-2790`).

### 6.5 Gotchas the implementer must respect

- `Zotero_Tabs.select(id)` **throws a TypeError for an unknown id**: `_getTab` returns
  `{ tab: undefined, tabIndex: -1 }` (`chrome/content/zotero/tabs.js:356-359`) and `select()`
  immediately does `this.parseTabType(tab.type)` (`chrome/content/zotero/tabs.js:848-849`) **before**
  the `if (!tab || …)` guard. Never pass a cached tab id without re-validating.
- `Zotero_Tabs.select()` is **synchronous** and returns `undefined` despite a JSDoc
  `@return {Promise}` (`chrome/content/zotero/tabs.js:838-847`). Do not `await` it expecting
  readiness.
- `Zotero.Reader.open` hardcodes `Zotero.getMainWindow()` (most-recent `navigator:browser`) for its
  stage-1 lookup (`chrome/content/zotero/xpcom/reader.js:2700`), while `ReaderTab`'s constructor
  uses `Services.wm.getMostRecentWindow('navigator:browser')`
  (`chrome/content/zotero/xpcom/reader.js:1787`). With two main windows open, an overlay in the
  non-frontmost window can open the tab in the *other* window. Mitigation: only accept activation
  when `Services.focus.activeWindow === win`; otherwise no-op and log.
- `ZoteroPane.selectItems()` can change the user's current collection selection as a side effect —
  it switches library, switches to Trash, or falls back to the library root if the item isn't
  visible in the current view (`chrome/content/zotero/collectionTree.js:716-767`). That is correct
  "reveal" behaviour; just don't be surprised.
- If the attachment is already open in a reader **window** (not tab), stage 2's
  `_readers.find()` matches the `ReaderWindow` and **no tab selection happens** — the call appears
  to do nothing in the main window (`chrome/content/zotero/xpcom/reader.js:2727-2738`). Accept for
  v1; note it in the README.

---

## 7. Cleanup

### 7.1 Per-window (`removeFromWindow(win)`) — called from `onMainWindowUnload` **and** `shutdown`

```js
const state = new WeakMap();   // ChromeWindow -> { root, style, keyHandler, hookedWindows, timers }

function removeFromWindow(win) {
  const s = state.get(win);
  if (!s) return;

  // 1. Listeners — identical function reference AND identical capture flag.
  try { win.removeEventListener('keydown', s.keyHandler, true); } catch (e) {}
  for (const w of s.hookedWindows) {
    try {
      if (!Components?.utils?.isDeadWrapper?.(w)) {
        w.removeEventListener('keydown', s.keyHandler, true);
        delete w[READER_HOOK_FLAG];
      }
    } catch (e) {}     // reader windows die with their tabs; dead-wrapper throws are expected
  }
  s.hookedWindows.clear();

  // 2. Document-level listeners added while the overlay was open
  try { win.document.removeEventListener('mousedown', s.outsideClick, true); } catch (e) {}

  // 3. Timers
  for (const t of s.timers) { try { win.clearTimeout(t); } catch (e) {} }
  s.timers.clear();

  // 4. DOM
  try { s.root?.remove(); } catch (e) {}
  try { s.style?.remove(); } catch (e) {}

  // 5. Drop every reference to the window / its nodes so the window can be GC'd.
  //    The sandbox OUTLIVES the window; a retained node keeps the whole window alive.
  state.delete(win);
}
```

`removeEventListener` needs the identical function reference **and** the same capture flag — Zotero's
own paired example is `chrome/content/zotero/xpcom/reader.js:1221` vs `:1240`. Store the handler on
the per-window state object; never re-create it inline.

### 7.2 Global (`destroy()`) — called from `shutdown` only

```js
function destroy() {
  if (notifierID) { Zotero.Notifier.unregisterObserver(notifierID); notifierID = null; }
  if (idleHandle) { cancelIdleCallback(idleHandle); idleHandle = null; }
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  index?.clear(); index = null;
  queryCache?.clear(); queryCache = null;
  cssText = null;
}
```

`Zotero.Notifier.unregisterObserver(id)` verified at
`chrome/content/zotero/xpcom/notifier.js:107-110`. Notifier observers are **global to the Zotero
singleton**, so registering per-window would double-fire and leak.

### 7.3 Idempotency

`addToWindow(win)` must early-return if `state.has(win)` **or**
`win.document.getElementById('qs-overlay')` already exists. Both `startup()`'s
`getMainWindows()` sweep and a racing `onMainWindowLoad` can target the same window; and
disable→enable re-runs `startup()` in the *same* sandbox with old state intact
(`chrome/content/zotero/xpcom/plugins.js:133-135`).

---

## 8. Test plan

### 8.1 Dev install (proxy file)

The mechanism is still implemented in the Firefox-140 toolkit Zotero 9 ships
(`[gre]/modules/addons/XPIProvider.sys.mjs:1106-1215`). With **Zotero fully quit**:

```bash
PROFILE="/Users/george/Library/Application Support/Zotero/Profiles/tbdh7sc6.default"

# 1. Proxy file: filename == the add-on ID exactly, no extension.
#    Contents: ONE line, absolute path to the plugin source directory.
printf '%s\n' '/Users/george/dev/zotero-search/plugin' \
  > "$PROFILE/extensions/quick-switcher@zotero-search.local"
```

The target must **exist and be a directory** or the toolkit silently **deletes** your proxy file as
"stale" (`[gre]/modules/addons/XPIProvider.sys.mjs:1155-1167, 1200-1210`). The ID inside
`manifest.json` must equal the filename or startup throws
`Invalid addon ID: expected addon ID X, found Y in manifest`
(`[gre]/modules/addons/XPIDatabase.sys.mjs:3290-3295`).

### 8.2 The two undocumented prefs you MUST set (verified against this profile)

Zotero ships `extensions.startupScanScopes = 0` and `extensions.autoDisableScopes = 15`
(`defaults/preferences/zotero.js:22-23`), and this profile currently has
`extensions.lastAppBuildId = "20260707110915"`. Consequences:

1. **The extensions dir is never rescanned.** `XPIStates.scanForChanges()` only uses `SCOPE_ALL`
   when `Services.appinfo.appBuildID !== extensions.lastAppBuildId`; otherwise it reads
   `extensions.startupScanScopes` (0) and `continue`s past every location
   (`[gre]/modules/addons/XPIProvider.sys.mjs:1521-1542, 1618-1625`). A newly dropped proxy file is
   **invisible**.
2. **A detected plugin is installed user-disabled.** `SCOPE_PROFILE` is 1 and 1 & 15 ≠ 0, so
   `XPIDatabase.addMetadata` sets `userDisabled = true; seen = false`
   (`[gre]/modules/addons/XPIDatabase.sys.mjs:3340-3367`).

Fix both, once, **with Zotero closed** (it rewrites `prefs.js` on shutdown):

```bash
cat >> "$PROFILE/prefs.js" <<'EOF'
user_pref("extensions.startupScanScopes", 1);
user_pref("extensions.autoDisableScopes", 0);
EOF

# Belt and braces for the very first launch only:
/usr/bin/sed -i '' '/extensions.lastAppBuildId/d' "$PROFILE/prefs.js"
```

`extensions.startupScanScopes = 1` (`SCOPE_PROFILE`) is the durable fix — the profile extensions dir
is then rescanned at every launch, so subsequent code edits need no pref surgery.

Do **not** touch `xpinstall.signatures.required`, `extensions.experiments.enabled` or
`devtools.chrome.enabled` — Zotero already ships them at dev-friendly values
(`defaults/preferences/zotero.js:1462, 1495, 1534`).

### 8.3 Launch with debug output

The profile name is `default` (`~/Library/Application Support/Zotero/profiles.ini`). The toolkit
flag is `-P` (uppercase), not `-p`. Run the **binary**, not `open -a`, or you get no stdout:

```bash
/Applications/Zotero.app/Contents/MacOS/zotero -P default -ZoteroDebugText -jsconsole 2>&1 \
  | tee /tmp/zotero-qs.log
```

- `-ZoteroDebugText` sets `CommandLineOptions.forceDebugLog = 1` (dump to stdout) and clears
  `toolkit.startup.recent_crashes` so Ctrl-C doesn't trip troubleshooting mode
  (`modules/BrowserContentHandler.sys.mjs:462-475`).
- `-jsconsole` opens the DevTools Browser Console
  (`[gre]/modules/DevToolsStartup.sys.mjs:517-538`).
- `Zotero.debug()` writes to stdout via `dump()` **only** when `_console` is true — i.e. with
  `-ZoteroDebugText` or `extensions.zotero.debug.log = true`
  (`chrome/content/zotero/xpcom/debug.js:53, 148`). There is **no plugin log file on disk**;
  stored debug output is an in-memory array (`chrome/content/zotero/xpcom/debug.js:28, 194`).
  `~/Zotero/logs/upgrade.log` is a DB schema log, unrelated.
- Prefix every log line: `Zotero.debug('[quick-switcher] …')` so `grep` works.

Bootstrap errors are **swallowed** and routed only to `Zotero.logError`
(`chrome/content/zotero/xpcom/plugins.js:213-215, 264-267`), so a broken plugin looks like "nothing
happened". Always develop with the terminal + Browser Console open.

`Tools → Developer → Run JavaScript` (`chrome://zotero/content/runJS.html`) evaluates code in the
**main window** via `win.eval()` (`chrome/content/zotero/runJS.js:19-26`) — use it to poke
`Zotero_Tabs`, `Zotero.Reader._readers`, and the index during development.

### 8.4 Manual test matrix

**A. Install & lifecycle**
1. Launch. `Tools → Plugins` shows "Quick Switcher 0.1.0", **enabled**. If it's disabled, §8.2 step 2
   didn't take. If it's absent, §8.2 step 1 didn't take.
2. `grep quick-switcher /tmp/zotero-qs.log` shows the startup line and no `logError`.
3. Disable → enable in the Plugins pane. Overlay still works, no duplicate `#qs-overlay` in the DOM
   (probe with Run JavaScript: `document.querySelectorAll('#qs-overlay').length` must be 1).

**B. Hotkey reachability — the critical test**
4. Library tab focused, click the items tree → **Cmd+O** → overlay appears, input focused.
5. Open a PDF in a reader tab. Click **inside the PDF page** so the pdf.js document has focus →
   **Cmd+O** → overlay appears. *If this fails*, see §9.1.
6. Same, but click into the reader's **sidebar** (annotations list) → Cmd+O.
7. Same, but open the reader's **find bar** (Cmd+F), put the caret in it → Cmd+O should still open
   the overlay (we `stopImmediatePropagation`).
8. Note tab focused → Cmd+O.
9. Cmd+O while the overlay is open → it closes (toggle).
10. **Cmd+Shift+O** must still create a new note (we must not have stolen it).
11. **Cmd+W** must still close the reader tab; **Cmd+1/2/3** must still jump tabs.

**C. Search & ranking**
12. Type a distinctive title word → the paper is rank 1.
13. Type a surname → papers by that author rank above papers merely containing the word in a title.
14. Type `surname 2019` → both tokens must match (AND).
15. Type an accented author unaccented ("muller" for "Müller") → matches (this is strictly better
    than Zotero's own search).
16. Type a 4-digit year alone → year matches appear, ranked below title matches.
17. Empty input → 10 most-recently-modified items.
18. Gibberish → "No results", Enter is a no-op.
19. Type fast (hold a key) → no dropped frames, no exceptions in the console.

**D. Result list**
20. First row is preselected and visually distinct.
21. ArrowDown ×15 → scrolls, selection tracks, wraps at the end of 50.
22. PageDown / Home / End behave as specified.
23. Mouse hover changes selection; click activates; the input never visibly loses focus.
24. Escape with text → clears; Escape again → closes.
25. Click the backdrop → closes.

**E. Enter behaviour**
26. Enter on a paper with a PDF → new reader tab, PDF focused, overlay gone.
27. Cmd+O again, same paper, Enter → **switches** to the existing tab; tab count unchanged.
28. Open 8 papers (Zotero unloads all but 3–5 reader tabs; `MAX_LOADED_TABS`,
    `chrome/content/zotero/tabs.js:35-36, 1009-1024`). Cmd+O → Enter on the *first* one, whose tab is
    now unloaded → must **switch**, not duplicate. (This is the case where `Reader.open` returns
    `undefined`, `chrome/content/zotero/xpcom/reader.js:2719`.)
29. Enter on a paper with **no** attachment → library tab, item selected in the tree.
30. Enter on a paper whose only attachment is a `.docx` → per the `fallback` pref: `library`
    (default) reveals; `viewItems` launches the OS handler.
31. Shift+Enter on any result → library tab, item selected.
32. Cmd+Enter → tab created in the background; focus stays where it was.
33. The "open" badge appears on rows whose paper already has a tab.

**F. Cleanup**
34. Open a second main window (`New Window`) → the overlay works in both, independently.
35. Close one window → `document.querySelectorAll('#qs-overlay')` in the survivor is still 1, and no
    exceptions.
36. Disable the plugin → `#qs-overlay` and `#qs-stylesheet` gone from every window; Cmd+O does
    nothing; no console errors.
37. Quit Zotero → clean shutdown, no `logError` from the plugin.

---

## 9. Ranked risks and de-risking

### Risk 1 — Hotkey does not fire while the PDF has focus (HIGH impact, LOW probability)

Everything in §0.1 says the chrome-window capture listener will fire. But the definitive proof is
Gecko C++ behaviour (event-target-chain construction across an in-process content docshell), which
cannot be read from `omni.ja`.

**De-risk (do this first, before writing any UI):** paste into Run JavaScript with a PDF tab open
and the PDF clicked:

```js
window.__qsProbe = (e) => Zotero.debug(
  `[qs-probe] key=${e.key} code=${e.code} meta=${e.metaKey} ` +
  `targetDoc=${e.target?.ownerDocument?.location?.href}`);
window.addEventListener('keydown', window.__qsProbe, true);
// press keys in the PDF, watch /tmp/zotero-qs.log
// teardown: window.removeEventListener('keydown', window.__qsProbe, true)
```

If the probe logs a `targetDoc` of `resource://zotero/reader/reader.html` or
`…/pdf/web/viewer.html`, the primary strategy is confirmed and
`extensions.zotero.quickSwitcher.hookReaderWindows` can default to `false`.
If it does not log, the §3.3 reader-window hookup carries the feature — ship it enabled.

### Risk 2 — The `position: fixed` div does not paint over / receive input above the reader (MED impact, LOW probability)

`#zotero-tab-cover` is the counter-evidence, but it lives inside the same `hbox` as `#tabs-deck`,
whereas ours is a child of `<window>`. Stacking-context reasoning says ours wins (root stacking
context vs. a nested `z-index: 1`), but it is unproven at that exact position.

**De-risk:** minimal probe in Run JavaScript with a PDF open:

```js
let d = document.createElement('div');
d.style.cssText = 'position:fixed;inset:20% 20%;z-index:2147483000;background:rgba(255,0,0,.85)';
d.textContent = 'HELLO';
document.documentElement.appendChild(d);
// visible over the PDF? clicking it does not scroll the PDF? then good. d.remove()
```

**Fallback:** switch to the XUL `<panel>` in the global `<popupset>` (§2.1). All search/rank/keyboard
logic is unchanged; only mount + show/hide differ. Budget half a day.

### Risk 3 — Focus lands in the wrong place after Enter (MED impact, MED probability)

`Zotero_Tabs.select()` fires the type's `refocus` hook on `setTimeout(…, 0)`
(`chrome/content/zotero/tabs.js:941-944`), and `Reader.open` calls `reader.focus()` at the end
(`chrome/content/zotero/xpcom/reader.js:2786-2790`), which itself defers via `setTimeout`
(`chrome/content/zotero/xpcom/reader.js:727-736`). If the overlay is still in the DOM when
`select()` runs, `document.activeElement` gets snapshotted as the library tab's
`lastFocusedElement` (`chrome/content/zotero/tabs.js:911-916`) and Zotero will later try to focus a
removed node.

**De-risk:** `hide(win)` is the **first** statement in `activate()`, and it does
`input.blur(); root.hidden = true;` synchronously before any `await`. Test case F/E-26..28 covers it.
If focus still misbehaves, `hide()` can additionally `win.document.documentElement.focus()`.

### Risk 4 — Dev install silently doesn't appear (LOW impact, HIGH probability on first attempt)

Three independent silent-failure modes: proxy file deleted as stale, extensions dir never scanned
(`startupScanScopes = 0`), plugin auto-disabled (`autoDisableScopes = 15`). All three verified
against this exact profile in §8.2.

**De-risk:** follow §8.2 verbatim, then confirm in `Tools → Plugins` before writing any feature code.
Diagnostic ladder: plugin absent → scan/proxy problem; plugin present but greyed → `autoDisableScopes`;
plugin present and enabled but inert → check `/tmp/zotero-qs.log` for `logError`.

### Risk 5 — `Zotero.Reader.open` returns `undefined` and the code dereferences it (LOW impact, MED probability)

Verified at `chrome/content/zotero/xpcom/reader.js:2719`: it returns `undefined` when it switches to
an existing **unloaded** tab. This is the *common* case, because Zotero unloads all but the 3–5
most-recently-used reader tabs (`chrome/content/zotero/tabs.js:35-36, 1009-1024`).

**De-risk:** never assign or dereference the return value (§6.3 does not). Test E-28 exercises it.

### Risk 6 — Index staleness after sync (LOW impact, MED probability)

Sync fires large batches of `item` events. Under-invalidating shows deleted papers; over-invalidating
rebuilds constantly.

**De-risk:** the debounced `staleIDs` set + the `> 500 ⇒ full rebuild` escape hatch in §4.5. Verify
by editing a title in Zotero and re-opening the switcher within a second or two.

### Risk 7 — Two main windows (LOW impact, LOW probability)

`Zotero.Reader.open` hardcodes `Zotero.getMainWindow()` (most-recent) for the existing-tab lookup
(`chrome/content/zotero/xpcom/reader.js:2700`), so an overlay in a background window can open the
tab in the foreground one.

**De-risk:** gate `activate()` on `Services.focus.activeWindow === win` (Zotero's own
window-activation idiom, `chrome/content/zotero/zoteroPane.js:1162`). Test F-34/35.

### Risk 8 — `getAll(onlyTopLevel)` leaking annotations into the index (LOW impact, HIGH probability if unguarded)

Measured: 1,553 of the 2,127 returned rows are annotations, because the SQL only `LEFT JOIN`s
`itemNotes` and `itemAttachments`, not `itemAnnotations`
(`chrome/content/zotero/xpcom/data/items.js:118-127`).

**De-risk:** the explicit `isRegularItem() || standalone-reader-attachment` filter in §4.2. Assert at
build time: `Zotero.debug('[quick-switcher] indexed ' + index.size)` — should be ~569 here, not 2,127.

### Risk 9 — CSS `<link>` with a `jar:` URL when packed as an XPI (LOW impact, only at packaging time)

Avoided entirely by injecting CSS as text (§2.3). Unverified either way; do not switch to `<link>`
without testing a packed build.

### Risk 10 — `strict_min_version: "7.0"` claim (LOW impact)

Everything here works on 9.0.6. Whether it works on 7.x is untested. Ship `"9.0"`; widen only after
testing.

---

## Appendix A — Verified API surface used by this plugin

| API | Kind | Returns | Citation |
|---|---|---|---|
| `Zotero.getMainWindows()` | sync | `ChromeWindow[]` (windowtype `navigator:browser`) | `xpcom/zotero.js:81-91` |
| `Zotero.getMainWindow()` | sync | `ChromeWindow \| null` | `xpcom/zotero.js:77-79` |
| `Zotero.Notifier.registerObserver(ref, types, id, priority)` | sync | `String` hash; throws on unknown type | `xpcom/notifier.js:68-105` |
| `Zotero.Notifier.unregisterObserver(id)` | sync | — | `xpcom/notifier.js:107-110` |
| `Zotero.Libraries.getAll()` / `.get(id)` | sync | `Zotero.Library[]` / `Zotero.Library` | `xpcom/data/libraries.js` |
| `library.waitForDataLoad('item')` | **async** | `Promise<void>` | `xpcom/data/library.js:407-419` |
| `Zotero.Items.getAll(libraryID, onlyTopLevel, includeDeleted, asIDs)` | **async** | `Promise<Item[] \| Integer[]>` | `xpcom/data/items.js:112-140` |
| `Zotero.Items.getAsync(ids)` | **async** | `Promise<Item \| Item[]>` | `xpcom/data/dataObjects.js:143-207` |
| `Zotero.Items.get(ids)` | sync | `Item \| Item[] \| false`; throws `UnloadedDataException` | `xpcom/data/dataObjects.js:96-140` |
| `Zotero.Items.loadDataTypes(objects, dataTypes?)` | **async** | `Promise<void>`; all types if omitted | `xpcom/data/dataObjects.js:450-469` |
| `Zotero.Items.getSortTitle(title)` | sync | `String` | `xpcom/data/items.js:1599-1612` |
| `item.getField(field, unformatted, includeBaseMapped)` | sync | `String` (`''` if absent) | `xpcom/data/item.js:237-308` |
| `item.getField('year')` | sync | `getField('date',true,true).substr(0,4)` | `xpcom/data/item.js:259-261` |
| `item.getField('firstCreator', true)` | sync | bidi isolates stripped | `xpcom/data/item.js:253-256` |
| `item.getCreators()` | sync | `[{firstName,lastName,fieldMode,creatorTypeID}]` | `xpcom/data/item.js:1135-1161` |
| `item.getDisplayTitle()` | sync | `String` (arg ignored in 9.0.6) | `xpcom/data/item.js:885-897` |
| `item.getItemTypeIconName(skipLinkMode?)` | sync | `String` | `xpcom/data/item.js:4809` |
| `Zotero.ItemTypes.getImageSrc(name)` | sync | `String` URL | via `item.getImageSrc()`, `xpcom/data/item.js:4803-4806` |
| `item.isRegularItem() / isAttachment() / isNote() / isAnnotation()` | sync | `Boolean` | `xpcom/data/item.js:2211-2554` |
| `item.attachmentReaderType` | sync getter | `'pdf'\|'epub'\|'snapshot'\|undefined` | `xpcom/data/item.js:3264-3280` |
| `item.getAttachments(includeTrashed)` | sync | `Integer[]`; **throws** on an attachment | `xpcom/data/item.js:3977-4010` |
| `item.numAttachments(includeTrashed)` | sync | `Integer` | `xpcom/data/item.js:2585` |
| `item.getBestAttachment()` | **async** | `Promise<Item\|false>`; throws on non-regular | `xpcom/data/item.js:4019-4030` |
| `item.parentID` | sync getter | `Integer \| false` | `xpcom/data/dataObject.js:29-33` |
| `item.deleted` | sync getter | `Boolean` | `xpcom/data/dataObject.js:107-132` |
| `win.Zotero_Tabs.getTabIDByItemID(itemID)` | sync | `String \| undefined`; **attachment** id | `tabs.js:524-527` |
| `win.Zotero_Tabs.select(id, reopening?, options?)` | **sync**, returns `undefined`; **throws** on unknown id | | `tabs.js:838-960`, `tabs.js:356-359` |
| `Zotero.Reader.open(itemID, location, opts)` | **async** | `Promise<ReaderInstance \| undefined>` | `xpcom/reader.js:2697-2791` |
| `Zotero.Reader.getByTabID(tabID)` | sync | `ReaderTab \| undefined` | `xpcom/reader.js:2676-2678` |
| `Zotero.Reader._readers` | array | live `ReaderInstance[]` (excludes unloaded tabs) | `xpcom/reader.js:2459` |
| `reader._initPromise` | Promise | resolves when the reader is up | `xpcom/reader.js:57-60` |
| `reader._iframeWindow` | window | `reader.html` content window | `xpcom/reader.js:1881-1883` |
| `reader._internalReader._primaryView._iframeWindow` | window | nested pdf.js/EPUB view window | `resource/reader/reader.js` |
| `win.ZoteroPane.selectItem(itemID, options?)` | **async** | `Promise<Boolean>`; switches to library tab | `zoteroPane.js:3099-3104` |
| `win.ZoteroPane.viewItems(items, event?, options?)` | **async** | `Promise<void>`; honours external-handler prefs | `zoteroPane.js:5032-5087` |
| `Zotero.File.getResourceAsync(url)` | **async** | `Promise<String>` | `xpcom/file.js:361` |
| `Zotero.getLocaleCollation()` | sync | `nsICollation` | used at `xpcom/data/item.js:4001` |
| `Zotero.Utilities.quotemeta(s)` | sync | regex-escaped `String` | `elements/tabsMenuPanel.js:482` |
| `Zotero.Prefs.get(name, global?)` / `.set` | sync | | throughout |
| `Zotero.debug(msg, level?)` / `Zotero.warn` / `Zotero.logError` | sync | | `xpcom/debug.js`, `xpcom/zotero.js:1315-1355` |

## Appendix B — Zotero 6/7-era patterns that will NOT work (do not copy from the web)

| Dead pattern | Replacement | Citation |
|---|---|---|
| `install.rdf` | `manifest.json` (MV2) with `applications.zotero` | `[gre]/modules/Extension.sys.mjs:1868-1885` |
| `chrome.manifest` in the XPI | none — address everything via `rootURI` | `[gre]/modules/Extension.sys.mjs:4604-4616` (langpack-only) |
| `<overlay>` / `overlay.xul` / `.xul` files | bootstrapped DOM injection, `.xhtml` | — |
| `Cc['@zotero.org/Zotero;1'].getService(…).wrappedJSObject` | `Zotero` is a sandbox global | contract absent from both omni.ja trees and the XUL binary |
| `defaults/preferences/*.js` | `prefs.js` in the plugin **root**, fully-qualified names | `xpcom/plugins.js:362-395` |
| `.dtd` entities / `.properties` bundles | Fluent `.ftl` under `locale/<locale>/`, auto-registered | `xpcom/plugins.js:424-549` |
| `ChromeUtils.import()` / `.jsm` | `ChromeUtils.importESModule()` / `loadSubScript` | `xpcom/plugins.js:185-199` |
| `OS.File` / `OS.Path` | `IOUtils` / `PathUtils` | sandbox globals, `xpcom/plugins.js:172` |
| `Zotero.Promise.coroutine/each/map` | native `async`/`await`; `Zotero.Promise` is a shim with only `.delay()`/`.defer()` | `xpcom/zotero.js:75` |
| `windowtype = "zotero:main"` | `navigator:browser` | `zoteroPane.xhtml:44`, `xpcom/zotero.js:77-91` |
| `strict_max_version: "7.0.*"` | `"10.*"` — 9.0.6 enforces strict compatibility | `[gre]/modules/addons/XPIInstall.sys.mjs:506-507` |
| `params.resourceURI` in bootstrap hooks | `params.rootURI` | `xpcom/plugins.js:248-255` |
