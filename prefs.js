// Default preferences for Zotero Quick Switcher.
//
// Loaded by Zotero.Plugins.setDefaultPrefs() (plugins.js:362-395) into the
// DEFAULT pref branch. Only pref() calls with boolean / string / number values
// are accepted here — anything else is logged as "Invalid type" and ignored.

// Hotkey that opens the switcher.
// Format: zero or more modifiers joined by "+", then the key.
// Modifiers: accel (Cmd on macOS, Ctrl elsewhere), ctrl, meta, alt, shift.
// Examples: "accel+O", "accel+shift+P", "alt+space".
//
// accel+O is free in Zotero 9 — it is not used by any keyset in the main
// window, by the extensions.zotero.keys.* shortcuts (which all require
// accel+shift), or by the reader's own KeyboardManager.
pref("extensions.quickswitcher.hotkey", "accel+O");

// When true (the default), Enter always opens the paper in a Zotero reader tab.
// When false, the switcher defers to Zotero's own file-handler preferences, so
// a paper opens in whatever external app you configured under
// Settings -> General -> "Open PDFs using" — matching double-click behaviour,
// but meaning Enter may not produce a tab at all.
pref("extensions.quickswitcher.alwaysOpenInZoteroTab", true);
