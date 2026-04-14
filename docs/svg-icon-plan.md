# PDCA Dashboard — SVG Icon Replacement Plan

**Status:** Plan complete (PDCA item #40)
**Author:** ops-agent
**Date:** 2026-04-14
**Implementation item:** TBD (separate PDCA item)

---

## 1. Motivation

The dashboard currently uses emoji characters for navigation icons, section headers, status indicators, and action buttons. Emojis render inconsistently across operating systems (macOS vs Linux vs Windows font stacks) and look out of place in a professional dark-mode SPA. The goal is a Linear/Vercel-quality UI where every icon is a predictable, pixel-aligned inline SVG.

---

## 2. Icon Set Choice: Heroicons (Outline, 20px variant)

**Rationale:**

- Heroicons (by Tailwind Labs) is the closest match to the Linear/Vercel aesthetic — thin strokes, geometric, clean.
- The "mini" (20px) variant is perfect for nav, table rows, and toolbar buttons at 16–20px display size.
- MIT licence — no attribution required, safe to inline.
- Consistent 1.5px stroke-width across all icons produces a unified look.
- All icons are available as self-contained `<svg>` fragments requiring only a `width`/`height` override.

**No icon font, no external CDN.** All SVG is inlined directly in the HTML template string, keeping the app single-file with zero runtime dependencies.

---

## 3. Full Emoji Inventory

The table below lists every non-ASCII character found in `server.js` that has visual/semantic meaning. Pure typographic glyphs (em dash `—`, arrows `→` / `←`, triangle sort indicators `▲` / `▼`, and the circular traffic-dot `●`) are NOT replaced — they are not emoji and already render consistently as text.

| # | Character | Unicode | Location(s) | Count | Semantic role |
|---|-----------|---------|-------------|-------|---------------|
| 1 | 📊 | U+1F4CA | Nav "Overview", empty-state icon, section title "Project Performance" | 3 | Dashboard / chart |
| 2 | 🗂 | U+1F5C2 | Nav "Items" | 1 | Items / index |
| 3 | 📅 | U+1F4C5 | Nav "Gantt" | 1 | Calendar / timeline |
| 4 | 📋 | U+1F4CB | Nav "Sessions" | 1 | Sessions / clipboard |
| 5 | 🔄 | U+1F504 | Nav "Cycles", section title "Activity Feed" | 2 | Cycles / repeat |
| 6 | 📁 | U+1F4C1 | Nav "File Changes" | 1 | Files / folder |
| 7 | ☰ | U+2630 | Hamburger mobile nav button | 1 | Menu / hamburger |
| 8 | ⟳ | U+27F3 | Spinner text, Refresh button, "Running…" button state | 3 | Refresh / loading |
| 9 | ▶ | U+25B6 | "Run Now" button, trigger row button, queue button | 6 | Play / run / trigger |
| 10 | ✅ | U+2705 | Toast (success), done-check in list, section title "Done This Week" | 3 | Success / check |
| 11 | ⚠️ | U+26A0 | Toast (warning), error empty-state icon | 3 | Warning |
| 12 | ❌ | U+274C | Toast (error) | 2 | Error / failure |
| 13 | ⏳ | U+23F3 | Toast ("queued"), trigger-cell for queued item | 2 | Pending / queued |
| 14 | ◀ | U+25C0 | Collapse sidebar button chevron | 1 | Collapse / chevron-left |
| 15 | ▾ | U+25BE | Column-toggle dropdown button | 1 | Chevron-down (small) |
| 16 | ⬜ | U+2B1C | "All" filter tab indicator | 1 | All / neutral |

**Characters NOT replaced (intentional text glyphs):**

| Character | Unicode | Why keep |
|-----------|---------|----------|
| — | U+2014 | Em dash — typographic separator, not an icon |
| → / ← | U+2192 / U+2190 | Arrow text in "View all →", pagination — fine as text |
| ▲ / ▼ | U+25B2 / U+25BC | Sort indicators rendered via CSS `::after` pseudo-elements — acceptable |
| ● | U+25CF | Traffic-light dots — intentional colored circles, already styled via CSS |
| ✓ | U+2713 | Small check in trigger cell (plain text size 11px) — borderline; see note below |

> **Note on ✓ (U+2713):** This is a plain-text fallback in the trigger cell for complete items at `font-size:11px`. It is acceptable to leave as-is or replace with a tiny inline SVG check. Recommendation: replace with a 12px SVG check for consistency.

---

## 4. SVG Definitions

All SVGs use `viewBox="0 0 20 20"`, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.5"`, `stroke-linecap="round"`, `stroke-linejoin="round"`. Size is set via `width` and `height` attributes.

Each icon is defined as a JS constant in a `const ICONS = { ... }` block placed at the top of the `<script>` section. This avoids repetition when the same icon appears in multiple contexts.

### 4.1 Nav Icons (16px, `display:inline-block`, `vertical-align:middle`)

**`ICONS.overview`** — chart-bar (Heroicons `chart-bar`)
```svg
<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2" y="10" width="3" height="8" rx="0.5"/>
  <rect x="8.5" y="6" width="3" height="12" rx="0.5"/>
  <rect x="15" y="2" width="3" height="16" rx="0.5"/>
</svg>
```

**`ICONS.items`** — list-bullet (Heroicons `queue-list`)
```svg
<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3.5 5h13M3.5 10h13M3.5 15h13"/>
  <circle cx="1" cy="5" r="0.5" fill="currentColor"/>
  <circle cx="1" cy="10" r="0.5" fill="currentColor"/>
  <circle cx="1" cy="15" r="0.5" fill="currentColor"/>
</svg>
```

**`ICONS.gantt`** — calendar (Heroicons `calendar-days`)
```svg
<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2.5" y="3.5" width="15" height="14" rx="2"/>
  <path d="M6.5 2v3M13.5 2v3M2.5 8h15"/>
  <circle cx="7" cy="12" r="1" fill="currentColor"/>
  <circle cx="10" cy="12" r="1" fill="currentColor"/>
  <circle cx="13" cy="12" r="1" fill="currentColor"/>
</svg>
```

**`ICONS.sessions`** — document-text (Heroicons `document-text`)
```svg
<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5 3h7l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>
  <path d="M12 3v4h4M7 9h6M7 12h6M7 15h4"/>
</svg>
```

**`ICONS.cycles`** — arrow-path (Heroicons `arrow-path`)
```svg
<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M16.5 10a6.5 6.5 0 0 1-11.13 4.58"/>
  <path d="M3.5 10A6.5 6.5 0 0 1 14.63 5.42"/>
  <path d="M14.63 5.42 16 4m-1.37 1.42L16 7.5"/>
  <path d="M5.37 14.58 4 16m1.37-1.42L4 12.5"/>
</svg>
```

**`ICONS.fileChanges`** — folder (Heroicons `folder-open`)
```svg
<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 6a2 2 0 0 1 2-2h3.172a2 2 0 0 1 1.414.586l1.414 1.414H16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z"/>
</svg>
```

### 4.2 Toolbar / Action Icons

**`ICONS.menu`** — bars-3 (hamburger, 20px)
```svg
<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
  <path d="M3 5h14M3 10h14M3 15h14"/>
</svg>
```

**`ICONS.refresh`** — arrow-path (20px, for refresh button and spinner)
```svg
<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M16.5 10a6.5 6.5 0 0 1-11.13 4.58"/>
  <path d="M3.5 10A6.5 6.5 0 0 1 14.63 5.42"/>
  <path d="M14.63 5.42 16.5 3.5m-1.87 1.92-.93 2.58"/>
</svg>
```

> Spinner animation: wrap in `<span id="fetchSpinner">` with CSS `@keyframes spin { to { transform: rotate(360deg); } }` and apply `animation: spin 0.8s linear infinite` when visible.

**`ICONS.play`** — play (triangle, 14px, for "Run Now" / trigger buttons)
```svg
<svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
  <path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.84z"/>
</svg>
```

**`ICONS.chevronLeft`** — chevron-left (collapse sidebar, 14px)
```svg
<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M13 16l-5-6 5-6" stroke-width="2"/>
</svg>
```

**`ICONS.chevronDown`** — chevron-down (column toggle, 12px)
```svg
<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5 8l5 5 5-5"/>
</svg>
```

**`ICONS.chevronRight`** — chevron-right (expand row indicator, 10px, replaces ▼)
```svg
<svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M8 5l5 5-5 5"/>
</svg>
```

### 4.3 Status / Feedback Icons

**`ICONS.checkCircle`** — check-circle (success toast, done-check, "Done This Week" section title)
```svg
<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="10" cy="10" r="8"/>
  <path d="M6.5 10l2.5 2.5 4.5-4.5"/>
</svg>
```

**`ICONS.warning`** — exclamation-triangle (warning toast, error empty-state)
```svg
<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M10 3L18 17H2L10 3z"/>
  <path d="M10 8v4M10 14.5v.5"/>
</svg>
```

**`ICONS.xCircle`** — x-circle (error toast)
```svg
<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="10" cy="10" r="8"/>
  <path d="M7 7l6 6M13 7l-6 6"/>
</svg>
```

**`ICONS.clock`** — clock (queued/pending state, replaces ⏳)
```svg
<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="10" cy="10" r="8"/>
  <path d="M10 5v5l3 3"/>
</svg>
```

**`ICONS.checkSmall`** — mini check (trigger cell for complete items, replaces ✓)
```svg
<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 10l5 5 7-8"/>
</svg>
```

### 4.4 Section Title Icons (inline before heading text, 14px)

| Section | Current | SVG to use |
|---------|---------|------------|
| "Project Performance" | 📊 | `ICONS.overview` at 14px |
| "Done This Week" | ✅ | `ICONS.checkCircle` at 14px |
| "Activity Feed" | 🔄 | `ICONS.cycles` at 14px |

### 4.5 "All" Filter Tab Indicator (replaces ⬜)

The "All" tab currently shows `⬜` as a neutral indicator. Replace with a plain 10×10 rounded square using inline SVG or a CSS box. Simplest approach: remove the indicator entirely from the "All" tab since `●` is only used for status tabs — the "All" tab has no meaningful status color.

Alternative: use a small grid icon:
```svg
<svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor" opacity="0.4">
  <rect x="2" y="2" width="7" height="7" rx="1"/>
  <rect x="11" y="2" width="7" height="7" rx="1"/>
  <rect x="2" y="11" width="7" height="7" rx="1"/>
  <rect x="11" y="11" width="7" height="7" rx="1"/>
</svg>
```

---

## 5. CSS Changes Required

### 5.1 Nav icon sizing
The current rule `.nav-item .nav-icon { font-size: 16px; ... }` controls emoji size via `font-size`. For SVG, change to:

```css
.nav-item .nav-icon {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.nav-item .nav-icon svg {
  width: 16px;
  height: 16px;
}
```

### 5.2 Empty-state icon
Current: `.empty-state .icon { font-size: 48px; }` — emoji sized via font.
Replace with:
```css
.empty-state .icon {
  width: 48px;
  height: 48px;
  margin: 0 auto 16px;
  color: var(--muted);
  opacity: 0.5;
}
.empty-state .icon svg {
  width: 48px;
  height: 48px;
}
```

### 5.3 Spinner animation
Add after existing animations:
```css
@keyframes spin { to { transform: rotate(360deg); } }
.spinning { animation: spin 0.8s linear infinite; display: inline-block; }
```

Apply `.spinning` class to the SVG inside `#fetchSpinner` while loading, and to the SVG inside `#runNowBtn` while the cycle runs.

### 5.4 Toast icons
The `showToast()` function currently prepends emoji. Update it to accept a `type` parameter (`'success'|'warning'|'error'|'info'`) and prepend the corresponding SVG icon span.

### 5.5 Section title icons
Section titles currently render emoji inline in JS string concatenation:
```js
'<div class="section-title">📊 Project Performance</div>'
```
Replace with:
```js
'<div class="section-title">' + ICONS.overview14 + ' Project Performance</div>'
```
Where `ICONS.overview14` is the 14px variant of the chart-bar icon.

---

## 6. Implementation Approach

### 6.1 ICONS constant block

Place a single `const ICONS = { ... }` object at the top of the `<script>` section (before any function definitions). Each key returns an HTML string containing the inline SVG. Example:

```js
const ICONS = {
  overview:    '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="10" width="3" height="8" rx="0.5"/><rect x="8.5" y="6" width="3" height="12" rx="0.5"/><rect x="15" y="2" width="3" height="16" rx="0.5"/></svg>',
  overview14:  '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="10" width="3" height="8" rx="0.5"/><rect x="8.5" y="6" width="3" height="12" rx="0.5"/><rect x="15" y="2" width="3" height="16" rx="0.5"/></svg>',
  // ... all icons listed in section 4
};
```

**Sizing convention:** default key = 16px, append `14` / `12` / `20` suffix for alternate sizes. Never use `em` sizing — always explicit `width`/`height` attributes.

### 6.2 Template literal safety

**Critical:** the SVGs may not contain backticks. All SVG attribute values use `"` double quotes — fine inside a JS template literal. However, any `${...}` expressions inside the SVG string must not exist. The SVG strings are pure static HTML — no interpolation needed.

Verify: after substituting each icon, run `grep -c "ICONS\." server.js` to confirm all references are valid before restarting PM2.

### 6.3 No-backtick SVG inline strategy

Since `server.js` uses a template literal (`DASHBOARD_HTML = \`...\``), every SVG that goes into the HTML section must be placed as a static string in the `const ICONS = {...}` block in the `<script>` section — NOT hardcoded directly in the HTML template body. The HTML body references icons through JS functions that return icon strings.

Exception: SVGs placed in the sidebar `<nav>` HTML section can use HTML directly because they are static markup (not generated by JS). But the `<script>` block is the safer unified approach.

---

## 7. Replacement Order (by risk and impact)

Group items from lowest risk to highest. Each group should be a separate commit.

### Group 1 — Nav sidebar icons (6 icons, HTML static section)
Files: the `<nav class="sb-nav">` block around lines 1304–1311.
Risk: low — static HTML, visual only.
Replace:
- `📊` → `ICONS.overview`
- `🗂` → `ICONS.items`
- `📅` → `ICONS.gantt`
- `📋` → `ICONS.sessions`
- `🔄` → `ICONS.cycles`
- `📁` → `ICONS.fileChanges`

Also:
- `☰` hamburger button → `ICONS.menu`
- `◀` collapse button → `ICONS.chevronLeft`

### Group 2 — Toolbar buttons (3 replacements)
Lines ~1325, 1336–1337.
- `⟳ Refresh` → SVG refresh icon + " Refresh"
- `⟳ Running…` (JS string) → SVG + " Running…"
- `▶ Run Now` → SVG play + " Run Now"
- `▾` column-toggle → `ICONS.chevronDown`

Also update the spinner `#fetchSpinner` to use SVG with `.spinning` CSS class.

### Group 3 — Section titles in overview (3 replacements)
Lines ~1908, 1910, 1913 in `renderOverviewPage()`.
- `📊 Project Performance` → `ICONS.overview14` + text
- `✅ Done This Week` → `ICONS.checkCircle14` + text
- `🔄 Activity Feed` → `ICONS.cycles14` + text

### Group 4 — Status indicators
- `✅` in done-check span (line ~1886) → `ICONS.checkCircle`
- `⏳` in toast and trigger cell (lines ~1570, 2537) → `ICONS.clock`
- `✓` in trigger cell for complete items (line ~2537) → `ICONS.checkSmall`
- `⬜` in "All" filter tab (line ~2371) → grid SVG or remove

### Group 5 — Toast messages
- `showToast()` currently prepends `✅`, `⚠️`, `❌` in the message string.
- Update `showToast(msg, duration)` to accept `showToast(msg, duration, type)` where type is `'success'|'warn'|'error'|'info'`.
- Internally map type → icon SVG prepended to `msg`.
- Update all 5 `showToast(...)` call sites to pass the correct type.

### Group 6 — Empty state and error state
- `📊` in the initial empty-state div (line ~1343) → `ICONS.overview` at 48px
- `⚠️` in the error empty-state (line ~1683) → `ICONS.warning` at 48px

---

## 8. Acceptance Criteria

After implementation, verify:

1. `grep -P '[\x{1F300}-\x{1FFFF}]|[\u23F3\u2705\u274C\u26A0\u2630]' /root/projects/pdca-ui/server.js` returns no hits.
2. Dashboard loads without JS errors (`pm2 logs pdca-dashboard --lines 20 --nostream`).
3. Nav icons render at correct size and color in both expanded and collapsed sidebar states.
4. Spinner rotates during data fetch (CSS animation active).
5. Toast messages show the correct SVG icon for each type.
6. The `⬜`, `▶`, `⟳`, and `◀` characters are gone from the rendered HTML.
7. All filter tabs still show their colored `●` dots (those are NOT being replaced).

---

## 9. Out of Scope

- The traffic-light dot `●` characters used in status badges — these are CSS-colored spans, not emoji, and work correctly.
- Sort indicator `▲` / `▼` in CSS `::after` pseudo-elements — these are fine as text.
- Pagination arrows `← Prev` / `Next →` — acceptable as text in button labels.
- Any icons added by future features — use the `ICONS` constant going forward.
