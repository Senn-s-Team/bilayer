# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-10-02

### Added

- A shared design layer under `extension/src/styles/`, loaded by every extension page. `tokens.css`
  declares nothing but custom properties — primitives (neutral ramps, brand blue, amber, success,
  warning, danger, font families, spacing/radius/type scales, control heights, durations and
  easing) plus semantic tokens named by role (`--bg`, `--fg`, `--surface`, `--border`,
  `--accent`, `--success`, `--warning`, `--danger`, `--focus-ring`, and the one floating shadow
  `--shadow-popover`) — and is the single
  source of truth for light and dark: `:root` holds the light branch and
  `@media (prefers-color-scheme: dark)` overrides the same names, so `color-scheme` is declared once.
  `controls.css` is the one baseline for controls — switches, `range` tracks (WebKit and Gecko
  written in pairs), color inputs, selects with a self-drawn `--select-arrow`, text/number/url/
  password/search/textarea fields, and three button tiers — each with hover, active, focus-visible
  and disabled states and the same focus ring. `settings.html`, `onboarding.html`, and
  `diagnostics.html` link both files before their own stylesheet and no longer declare a local
  palette, a second light/dark branch, or a duplicate control baseline; the page stylesheets keep
  only layout and variant overrides, and every page's frozen class names (`.btn`, `.preset-chip`,
  `.icon-btn`, `.quiet-button`, `.payload-format`, …) are listed as members of a shared tier rather
  than re-declared.
- `runtime.action.onClicked` plus a `BILAYER_OPEN_SETTINGS` message, both routed through one
  `openSettingsWindow()` in the background: an already-open settings page is only focused (a second
  click never stacks another window), then a remembered window id is verified with `windows.get` and
  focused, then `windows.create({ type: "popup", width: 1240, height: 940, url })` opens the window,
  and engines without a usable `windows` API fall back to `tabs.create`. The height is the window's
  **outer** size: Chrome's title bar eats about 88 px, so 940 leaves an inner height of roughly 852,
  which keeps the tallest tab (the AI page, ≈717 px of content) on one screen with no panel
  scrolling. The width is 1240 so the wider rail (see the clamp below) still leaves the content
  column roughly as wide as before. The remembered id lives in `storage.session` under `__settings_window_id__` (nothing to
  clean up when the session ends) and falls back to `storage.local` invalidated on
  `runtime.onStartup`, so an id from a previous session can never focus an unrelated window.
- Motion primitives and the flat token vocabulary behind the settings surface.
  `extension/src/settings/settings.css` adds `@keyframes bl-rise` (a tab panel's direct children
  rise into place over 780 ms via `--bl-duration-panel`, staggered 45 ms per item and capped at the
  eighth), `bl-breathe` (the loading state) and `bl-pop` (the selected mark growing in); all three
  animate only `transform`/`opacity`. A single `prefers-reduced-motion: reduce` block at the
  end of `extension/src/styles/controls.css` neutralises transition and animation durations for all
  three sharing pages, and the settings sheet keeps its own stricter copy that also forces
  `animation: none`, so a reduced-motion element lands in its natural state instead of staying
  invisible through a delay. `extension/src/styles/tokens.css` carries the vocabulary that flat
  language draws from — the radius ladder `--bl-radius-2xs/-xs/-sm/-md/-lg/-xl` (2/3/4/6/8/10 px, no
  capsule step) with the three role aliases `--radius-tag` (badges, labels, progress bars, subtitle
  lines), `--radius-control` (buttons, inputs, segments, list rows) and `--radius-surface` (panels,
  cards, popovers, while a window-level shell takes `--bl-radius-xl`), the durations
  `--bl-duration-slower/panel`, the easings `--bl-ease-out-expo/inout-quint/springy`, and the
  semantic pair the flat contract is built on — `--groove` (the one recessed fill) and
  `--shadow-popover` (the one floating shadow). The glass vocabulary it replaced is deleted in the
  same pass (`--bl-bezel*`, `--bl-radius-shell*/core*/2xl/pill/circle`, `--shell-ring*`,
  `--shell-tray`, `--core-base`, `--core-sheen*`, `--core-ring`, `--rail-sheen`, `--groove-ring`,
  `--groove-inset`, `--switch-inset`, `--thumb-shadow`, `--shadow-soft*`, `--shadow-card`,
  `--shadow-header`, `--shadow-accent`, `--accent-glow`, `--stage-frame*`, `--stage-sheen`,
  `--stage-inset`, `--surface-blur`, `--bl-shadow-lg`), each remaining name declared under both the
  light `:root` and the dark `prefers-color-scheme` branch.
- Regression coverage for the diagnostics page and the in-place status flow: a new
  `scripts/diagnostics.test.mjs` exercises the four export outcomes through `#exportStatus` plus the
  "render as UI" ruby path, and `scripts/settings.test.mjs` gains five cases for the draft
  endpoint/model-fetch failures being reported in place. The suite goes 206 → 216 and `npm run check`
  stays green.

### Changed

- The settings UI is no longer the toolbar popup. `extension/manifest.json` drops
  `action.default_popup` (leaving `action.default_title`): as long as that key exists the browser
  opens the popup itself and swallows `action.onClicked`, so removing it is what hands the toolbar
  click back to the extension. Clicking the icon now opens or focuses a standalone, resizable
  settings window that defaults to 1240×940 (outer height; ≈852 inner), and the module moved with it:
  `extension/src/popup/` became `extension/src/settings/`, with
  `popup.html`/`popup.css`/`popup-ai.css`/`popup.js` renamed
  to `settings.html`/`settings.css`/`settings-ai.css`/`settings.js`, `scripts/popup.test.mjs` to
  `scripts/settings.test.mjs`, and the ten `popup*` message keys to `settings*` in both bundles
  (`_locales/en` and `_locales/zh_CN` stay key for key).
- **User-visible:** the interface now follows the system appearance. The previous `:root` block was
  permanently dark; light is now the default branch and dark is applied by `prefers-color-scheme`
  overriding the same tokens, so the settings window, wizard, and diagnostics page switch with
  macOS instead of staying dark.
- The settings window uses the whole viewport: `html, body` fill it with no page-level scrollbar and
  `.tab-panel` is the only scroll source (the appearance page no longer nests a second scroller).
  At ≥900 px the subtitles panel uses two columns, the AI page lays its four cards out 2×2, and the
  provider page widens into a master/detail split; at ≤820 px the sidebar collapses into a top tab
  bar, so the default 1240×940 window and smaller resizes both work.
- **User-visible:** the settings rail is wider and no longer cramped. `.app-shell`'s first column
  goes from a fixed `168px` to `clamp(180px, 17.5%, 224px)`, so it scales with the window (≈217 px at
  1240 wide, ≈180 px at 1000) instead of staying pinched, and the `168px` workarounds it forced are
  gone: `.sidebar-language-label` and `.sidebar-language-select` lose their negative inline margins,
  `width: calc(100% + 12px)` compensation and `letter-spacing: -0.02em` tightening (the select
  returns to the baseline self-drawn arrow and padding). The tab buttons take a step more horizontal
  padding and a 38 px row height — the flat selected state (`--accent-soft` fill, 2 px accent bar,
  `bl-pop`) and the focus ring are unchanged. The provider page's wide-viewport master column widens
  from 200 px to 240 px. `openSettingsWindow()` widens the window to 1240 (height still 940) so the
  content column keeps its width and the four panes still fit with no panel scrollbar.
- **User-visible: the visual direction switched from a translucent double-shell language to a flat,
  engineered surface.** The intermediate pass drew every settings card as a pure-CSS double shell
  (a 6 px `transparent` border split by `background-clip`/`background-origin` into an aluminium
  tray + core + top sheen, with concentric corners and multi-layer diffuse shadows); that is gone
  in favour of **one opaque surface + a 1 px `--border` hairline + one corner-radius ladder + a
  single shadow for floating layers only**. `.settings-list`, `.track-grid`, `.style-section`, and
  `.ai-section` are now a flat `--surface` fill with a 1 px `var(--border)` edge and
  `--radius-surface` (6 px), no `border` transparency, no `background-clip`, no sheen and no shadow;
  hover lifts the edge to `--border-strong` only. The nested groups (`.ai-toggle-list`,
  `.provider-editor`, `.ai-credential`, the segmented-control troughs, `.preset-list`,
  `.role-selector`) are recessed `--groove` fills with the same hairline, and `settings-ai.css`
  reuses that construction for the provider master/detail split and the small model-menu popover,
  which is the one element allowed the single `--shadow-popover`. Hierarchy is therefore expressed
  by the hairline and surface-value differences alone. All large-radius and capsule corners are
  removed (`--bl-radius-*` sits at 2/3/4/6/8/10 px with no `pill`/`circle` step) and the three page
  stylesheets reference the role aliases rather than raw steps, while the type, spacing and motion
  scales are unchanged. The sans stack drops `"Helvetica Neue"`
  (`-apple-system, BlinkMacSystemFont, system-ui, "SF Pro Text", "SF Pro Display", sans-serif`) and
  `--bl-ease-standard` goes from `ease` to `cubic-bezier(0.32, 0.72, 0, 1)`. Two contrast
  corrections carried over: `--bl-blue-600` `#2f6fe4 → #2b66da` (white text on the solid primary
  button 4.65 → 5.23) and `--bl-green-700` `#14883f → #0f7a38` (light `.track-status[ready]` 4.47 →
  5.35); the lowest re-measured pair is 5.00:1, none under 4.5:1. Hover feedback is graded — passive
  containers keep only the hairline and never translate, while interactive elements (`.select-card`,
  `.preset-pill`/`.preset-chip`, segmented buttons, tabs, the three button tiers, model-menu rows,
  provider-list rows) keep their ≤2 px lift and `.98` press, and the sidebar's 向导/诊断 `↗` now
  sits in its own 20 px square chip (`--bl-radius-2xs` + `--groove`) that shifts diagonally and
  scales on hover. At wide viewports cards size to their content (`align-items: start`) so a short
  card no longer stretches into a dead column, and the subtitles and provider pages are rebalanced
  accordingly. `tokens.css`/`controls.css` are shared by settings, onboarding, and diagnostics; both
  other pages were re-checked for regressions and given the same flat treatment (see the entries
  below).
- **User-visible: blocking `window.alert` dialogs are gone from both extension pages.** The eight
  call sites — five in `extension/src/settings/settings.js`, three in
  `extension/src/diagnostics/diagnostics.js` — now write their message into an in-place status line:
  the settings window's new `#newDraftStatus` (`extension/src/settings/settings.html`) and the
  diagnostics head's new `#exportStatus` (`extension/src/diagnostics/diagnostics.html`), both
  `role="status" aria-live="polite"`, with `data-state="error"` set on failure and the empty text
  hidden by `.live-status:empty`. Every message reuses the existing i18n keys — **no new keys are
  added** — and each former `alert` keeps its control flow (the early `return` after the message).
- `extension/src/diagnostics/diagnostics.css` (960 lines) is split by concern to stay under the
  repo's ≤800-line limit: `diagnostics.css` now holds the page shell, request list, detail header and
  connection drawer, and a new `diagnostics-payload.css` holds the payload toolbar, the searchable
  JSON tree and the subtitle-preview card. `diagnostics.html` links them in order
  tokens → controls → diagnostics → payload, and both files keep the flat contract (hairline and
  surface-value layering, `--radius-tag/-control/-surface`, no sheen/blur/shadow). The collapsed
  JSON-node marker no longer carries the hardcoded Chinese `content: " · 已折叠"`; it is drawn
  geometrically (a border-built chevron rotated by state) so no locale text lives in CSS.
- The onboarding page (`extension/src/onboarding/onboarding.css` + `onboarding.html`) is reworked to
  the flat contract and hardened: the window uses `100dvh`/`92dvh` instead of `100vh`/`92vh`,
  `.step-viewport` is the single scroll source so the footer is never pushed off, seven inline
  `style=` attributes are moved to classes (`.is-hidden`/`.is-invisible`/`.select-card.is-static`),
  the `👁` emoji is replaced by an inline SVG at the same stroke spec as the page's other icons,
  static option cards are distinguished with `.is-static` so they no longer read as clickable, and
  the blanket `transition: all` and width transitions are removed in favour of explicit
  `--bl-ease-*` transitions; headline copy gains `text-wrap: balance` and a line-length cap.
- Both READMEs' **Credits** section drops the references that the flat switch made untrue: the
  macOS/Apple entry no longer claims translucent `backdrop-filter` surfaces (the pages are flat),
  and the Neumorphism bullet is removed, leaving the system font stack and spring easing as the
  acknowledged Apple-adjacent styling. The two READMEs stay section-for-section aligned.

### Fixed

- `isAllowedTestSender` no longer identifies the settings UI by "URL matches and `sender.tab` is
  absent". Documents in a standalone window carry `sender.tab` exactly like tab documents, so that
  rule silently rejected **Test connection**, **Fetch models**, and the AI readiness query from the
  new window form. Authorization is now `sender.id === runtime.runtime.id` plus the settings/
  onboarding URL allowlist (the identity check stays mandatory, so nothing widens to arbitrary
  extension pages or web pages).
- The long-lived settings window no longer polls Netflix while it is hidden:
  `scheduleStatePoll` bails out on `document.hidden` before any `tabs.query`/`sendMessage`, and a
  `visibilitychange` listener restarts the chain the moment the window becomes visible again, so the
  timer cannot stall permanently and a background window issues no page reads.
- Provider edits no longer drop concurrent changes. `providers` is stored as one array and the
  onboarding wizard writes the whole array, so editing a field, adding a service, or deleting the
  active service now reads the latest stored list back (`readLatestProviders`) and merges by id
  instead of writing a stale in-memory snapshot over services added elsewhere in the meantime; a
  deletion that would empty the list falls back to a clone of the default providers.
- `i18n.t()` dropped every placeholder on the default `auto` path. `fromBrowser` called
  `runtime.i18n.getMessage(key)` with no substitutions, and a browser blanks an unsupplied
  `$1…$9` to an empty string, so the local `$n` replacement then had nothing left to substitute — all
  31 keys that carry `$n` rendered as half a sentence in the default language (the AI page's usage
  readout showed `:  /  requests ·  /  characters`). The browser call now receives arguments
  (`fromBrowser(key, substitutions)`), `t()` returns a bundled hit through the local `substitute()`
  and otherwise `fromBrowser(key, browserArguments(args)) || key`, and `browserArguments()` pads to
  nine slots with each missing slot filled by its own literal `$n` — the one thing that survives
  Chrome's blanking, since both `getMessage(key)` and `getMessage(key, [])` strip them — so `auto` and
  the bundled path agree on a single semantics: substitute in order, keep an unsupplied placeholder
  literal, and never re-expand a substituted value (verified: the browser does not expand argument
  values a second time). `scripts/i18n.test.mjs` doubles that blanking behaviour in its `getMessage`
  stub and adds four regressions — `auto` keeps every supplied value, unsupplied arguments stay
  literal on both paths, explicit locales still resolve from the bundle without consulting the
  browser, and a throwing or absent `getMessage` still degrades to the key. Three of the four fail
  against the pre-fix code and all pass after (24/24; the full suite goes 202 → 206). End to end,
  `auto` and `en` render `This watch session: 0 / 80 requests · 0 / 40,000 characters` and `zh_CN`
  renders `本次观看：请求 0 / 80 · 字符 0 / 40,000`, and the other placeholder key `providerSavedHost`
  returns from `Saved ; grant domain permission before use` to `Saved api.example.com; …`. **Known
  and deliberately unfixed:** the same defect still exists in
  `extension/src/background/service_worker.js`'s `localizedMessage(key, uiLanguage)` fallback
  (`:822`), which likewise passes no substitutions; it is currently unreachable because the only keys
  it fetches (`noticeProviderMissing`, `noticeSubtitleTracksMissing`, `noticeSubtitleTracksUnread`)
  carry no `$n`, but adding `$n` to a background-delivered message would reproduce it (recorded in
  `extension/src/background/CLAUDE.md`).
- `renderRubyTextTo` in `extension/src/diagnostics/diagnostics.js` threw a `ReferenceError` because
  it matched on an undeclared `rubyPattern`; the bug was user-reachable by opening an older payload
  that carried `ruby` markup and switching to the **Render as UI** tab, which blanked the payload
  area with no message. The regex is now constructed locally inside the function, matching
  `extension/src/content/overlay.js`'s `renderRubyText`, so a shared `g`-flagged constant can no
  longer leak `lastIndex` between calls and truncate later renders.

## [0.3.5] - 2026-09-29

### Added

- An **Active translation service** selector at the top of the popup's AI page
  (`select#aiProviderSelect`), so the provider that translates can be switched while configuring AI
  instead of only from the **Translation Services** tab's master list. Its options are the already
  configured providers (`currentProviders`, labelled with the service name and its model) and its
  value is the active `aiProviderId`; changing it writes the same `{aiProviderId}` key the provider
  tab writes and immediately re-renders the selector, the provider tab's master-list selection and
  the AI readiness notice, then reuses the existing state poll (`scheduleStatePoll(0)`) so the
  content-side readiness and translation follow without a new protocol. The two entry points stay
  consistent in both directions — choosing a service in the provider tab flows back into this
  selector, and deleting the active provider falls back through the existing normalization. The
  selector always lists at least one entry: the storage-driven path falls back to the default
  provider when the stored list is empty (`currentProviders` is never empty there), so "no service
  configured" is not a state this select reaches — it is reported by the availability/readiness
  warning above it, and a selected provider without a credential likewise reuses that same existing
  warning (no second hint). If the provider list were ever empty the select renders a disabled
  placeholder with an explanatory `title`/`aria-label` as a defensive guard; either way it never
  reads or displays credentials. Added `aiProviderSection`, `aiProviderSelect`, `aiProviderNone`,
  `aiProviderEmptyHint`, and `aiProviderHelp` to both bundles (`_locales/en` and `_locales/zh_CN` stay
  key for key, order included, 387 messages each as of this entry), and both READMEs mention the
  selector in their AI section.
- A fourth `subtitleAvailability` state, `unread`, for the stall case where the page bridge never
  publishes a track payload: after a short wait on a watch page with playback context the extension
  reports `unread` instead of leaving the state `unknown`. The popup renders it as a distinct, softer
  notice in the same two places as the hard warnings — it says the tracks could not be read (rather
  than that the title has none), points to refreshing the page or playing another title, and keeps
  the AI mode card selectable with no `aria-disabled`/`is-unavailable` treatment, so the stalled read
  never blocks AI; only a definitive `none` still blocks it, and `unknown` stays warning-free. The
  `BILAYER_AI_READINESS` payload gains `unreadNotice`, backed by `noticeSubtitleTracksUnread`, for the
  overlay hint at the subtitle position. Added `noticeSubtitleTracksUnread`,
  `aiUnavailableTracksUnread`, and `aiUnavailableTracksUnreadHint` to both bundles (`_locales/en` and
  `_locales/zh_CN` stay key for key, 382 messages each as of this entry), and both READMEs describe the
  stall case in their AI section.
- Availability and readiness surfacing for AI translation. The popup reads the page state's
  `subtitleAvailability` (`unknown`/`none`/`available`) and `providerReadiness` (`{configured,
  notice}`) defensively — absent fields keep the previous behaviour, and `unknown` never warns
  because the tracks may still be loading — and shows one warning block both under the mode cards
  and at the top of the AI page. When Netflix published no tracks for the title it shows
  `aiUnavailableNoTracks`, marks the AI mode card `aria-disabled` and dimmed, and disables the AI
  source-track select. A stored AI choice is preserved rather than silently reverted to native: the
  card stays selected while carrying `aria-disabled` and `.is-unavailable`, and clicking it opens the
  AI page and focuses the explanation instead of doing nothing — what is blocked is *newly selecting*
  AI while the title has no tracks, and the saved mode applies again on a title with tracks. When AI
  mode is on with no provider configured it shows `aiUnavailableNoProvider` with a
  `aiConfigureProviders` link to the **Translation Services** tab. Both notices are recomputed by the
  existing state poll, so they clear as soon as the state changes, and the shared hint keys
  `noticeProviderMissing` / `noticeSubtitleTracksMissing` back the overlay hints at the subtitle
  position. `_locales/en` and `_locales/zh_CN` stay key for key (379 messages each as of this
  entry), and both READMEs state the two preconditions in their AI section.
- Configurable translation input caps with a live usage readout. `aiRequestBudget`
  (default 80, 0–1000) and `aiCharacterBudget` (default 40,000, 0–1,000,000) bound the input a single
  accounting window may send; `0` means unlimited for that cap, independently of the other, and an
  absent or invalid stored value falls back to the default. The AI page shows both fields beside
  the pre-translation and context settings, and the readout underneath follows the existing state
  poll to show requests and characters used against each cap, rendering `unlimited` for an
  uncapped side and naming the cap that stopped translation when `budget_exceeded` arrives. With
  no Netflix page connected it shows zero usage with the configured limits instead of failing.
  Raising a cap mid-session resumes translation without discarding already-translated lines, and
  lowering one below the consumed amount stops new requests immediately. The popup's locale keys
  and README prose for the two caps follow the existing naming and structure.
- Windowed and persisted accounting for those caps, chosen by a **Cap accounting window** selector on
  the same AI page. `aiBudgetWindow` is `session` (default — the current watch page/episode), `hour`,
  or `day`; a missing or invalid stored value falls back to `session`. `session` now survives a
  refresh of the same page, and `hour`/`day` are local-time buckets that also survive reloads. Usage
  is persisted in `runtime.storage.local.__ai_budget_usage__` under its concrete window key
  (`session:<watchId>`, `hour:<YYYY-MM-DDTHH>`, `day:<YYYY-MM-DD>`), so it is tracked per window key:
  reloading the page, reopening the tab or reopening the popup continues that window's count instead
  of starting over, and tabs sharing a window key align against the persisted usage before
  dispatching. `BILAYER_GET_STATE.translationBudget` gains optional
  `window` (effective window id) and `windowKey` (concrete anchor) fields, and the readout names the
  window it counts over — taking the page state's `window` when present and falling back to the stored
  setting, and degrading to that stored value when the extension fields are absent. The `_locales/en`
  and `_locales/zh_CN` bundles stay key for key (373 messages each as of this entry), and both READMEs
  describe the window in their AI section.
- Interface-language switcher, persisted as `runtime.storage.local.uiLanguage`: `auto` follows the
  browser and is the default, with `en` and `zh_CN` as explicit choices. `extension/src/i18n.js`
  auto-mounts it on every `data-i18n-language` select (the popup sidebar and the onboarding header)
  and reloads the page on change. The `_locales/en` and `_locales/zh_CN` bundles match key for key
  (368 messages each when this entry was written).
- Provider model discovery in the onboarding wizard's AI step, sharing the background
  `BILAYER_LIST_MODELS` protocol with the popup's "Fetch models" button.
- An in-page completion state for the wizard's final step, replacing a finish button that did
  nothing.
- "Credits" and "Roadmap" sections in both READMEs, with identical structure. Credits records the
  references the changelog already described (film-subtitle constraints borrowed from 沉浸式翻译 /
  Immersive Translate, the diagnostics viewer interaction recorded as "借鉴 fx", Neumorphism and
  the macOS/Apple material language, the reimplemented Netflix track observation and the
  `netflix-track:` scheme, and the OpenAI-compatible Chat Completions contract including the
  sanitized `cases/` fixtures), the Apple toolchain used to build and sign, the absence of any
  vendored third-party source or licensed asset, and the maintainer-supplied icon artwork. Roadmap
  gives the verdict per engine — Chromium loads and runs the unmodified `extension/` (verified with
  a real Chrome for Testing load: popup, background round trip, content-script boot on a Netflix
  watch URL, `_locales` sync XHR) and needs no code or manifest change, while Firefox is a
  small-to-medium port (event page instead of `service_worker`, `gecko.id`, store data-collection
  declaration, host-permission recovery, unverified `window.Bilayer` sharing) — and keeps what a
  real load or a code read confirmed separate from what remains an assumption. It also names
  additional video sites as the largest item and lists the documentation and screenshot work.

### Changed

- The app and extension icon is now the maintainer-supplied artwork: `extension/icons/icon-source.png`
  (1024², square, the subtitle-bubble-and-play-triangle glyph centred on a transparent canvas with an
  even margin, nothing touching the edges) replaces `icon.svg` as the single hand-maintained source,
  and all seven derived PNGs are regenerated from it. `scripts/build-icons.sh` now refuses a master
  that lost its alpha channel or its square shape, because either would ship opaque corners at every
  derived size. Preparation of the master is documented in `extension/icons/CLAUDE.md`: detached
  particles left by the background-removal export (connected components under 0.5% of the glyph's
  area) are dropped and alpha below 8/255 is zeroed, so the shipped master holds exactly one
  silhouette component and no sub-threshold pixels.
- `manifest.json` adds a `1024` icon entry that points at `icon-source.png` itself, so no derived
  duplicate is committed and `npm run icons` keeps deriving only 16/32/48/96/128/256/512. The Safari
  converter sizes the host app icon from the manifest entry nearest its ideal pixel size, so the
  1024 app-icon slot is now drawn from the native master instead of a 1.199x upscale of
  `icon-512.png`; over the 614 px artwork box the worst-case deviation from a native master
  downsample drops from 142 to 3 RGB units.
- The onboarding appearance ("Look") step now mirrors the popup appearance panel: line-height and
  max-width sliders, popup-identical preview math, and working text/background/outline color
  swatches. It also defines the previously undefined `--accent-deep` custom property.
- README UI position names now follow the reader's locale: the English README quotes the English UI
  labels and the Chinese README quotes the shipped Chinese labels.

### Fixed

- The caps were accounted per page/subtitle epoch, so a refresh reset the count and made the guard
  meaningless — the design flaw this release corrects. Accounting is now windowed and persisted (see
  *Added* above), with `session` continuing across a refresh of the same episode instead of starting
  from zero.
- The raw-capture preference read was fail-open and latched on failure: when
  `storage.local.get` threw (or reported `runtime.runtime.lastError`), `loadRawDiagnosticsIfNeeded()`
  marked itself loaded without reading `__raw_capture_enabled__`, so a persisted `off` was ignored for
  the rest of that worker's life and the module default `true` kept capturing subtitle text. The
  preference is now unknown-until-read with `rawCaptureEnabled` initialised to `false`, a failed read
  is never cached (the next call retries) and never sets a capture value, and a successful read still
  honours the documented default `true` when the key is absent. `BILAYER_SET_RAW_DIAGNOSTICS` now
  assigns and persists immediately instead of awaiting the pending read, marks the preference as
  user-set so a late read cannot overwrite it, and writes only `__raw_capture_enabled__` so an
  unloaded buffer can never replace stored records. The preference is likewise never persisted while
  unknown: `persistRawDiagnostics()` includes `__raw_capture_enabled__` only once a read has succeeded
  or the user has toggled, and `BILAYER_CLEAR_RAW_DIAGNOSTICS` now awaits that read like GET, so
  clearing records can no longer write the fail-closed placeholder over a stored value the worker
  never read (the buffer, version, and sequence keys are still written in every case).
- The raw-payload capture toggle (`rawCaptureEnabled`) lived only in a module-level variable, so
  turning capture off in the diagnostics page was silently reverted to on whenever the background
  service worker was reclaimed and restarted, and the page then rendered `enabled: true` again.
  The flag is now persisted as `__raw_capture_enabled__` with the other diagnostics keys and
  reloaded by `loadRawDiagnosticsIfNeeded()`; the translate path awaits that load immediately
  before the capture decision, so even the first request after a restart reads the stored value.
- Onboarding preset chips shared one handler, which also matched the role, reset, and layout chips
  and left them dead; the handler now binds only chips carrying `data-preset`.
- The wizard's temporary `onboarding-test` provider is filtered out before the provider list is
  saved, so it is no longer persisted.

## [0.3.0] - 2026-09-27

Renamed from `Netflix Dual Subtitles Safari` to `Bilayer`. The name, icon, and UI accent
color no longer use the Netflix trademark, which risked App Review rejection under
guidelines 5.2.1 and 2.3.x.

### Added

- `scripts/build-icons.sh` and `npm run icons`: derive the full 16/32/48/96/128/256/512 icon
  set from `icon.svg` via `sips`, and assert that `manifest.json` only references files that
  exist. The docs previously claimed this derivation happened, but no script implemented it.
- `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`.
- `.github/workflows/ci.yml` running `npm run check` and `npm test` on Node 22 and 24.
- `.editorconfig`.
- `package.json` now declares `license`, `engines`, `repository`, `homepage`, `bugs`,
  `description`, and `keywords`.
- English UI with localization support. `extension/manifest.json` declares
  `"default_locale": "en"` and resolves `name`, `description`, and `action.default_title` from
  `__MSG_*` messages; `extension/_locales/en` and `extension/_locales/zh_CN` each define the same
  356 keys. A new `extension/src/i18n.js` exposes `i18n.t()`, `i18n.apply(root)`, and
  `i18n.uiLanguage()`, drives `data-i18n` / `-placeholder` / `-title` / `-aria-label` attributes,
  and syncs `document.documentElement.lang` with `runtime.i18n.getUILanguage()`. The popup,
  onboarding, diagnostics, and export pages load it before their own scripts. Content scripts and
  the page bridge stay unlocalized: they render subtitle text, not UI.
- Tag-triggered release pipeline. `.github/workflows/release.yml` runs on `v*` tag pushes on
  `macos-latest`, asserts the tag matches `extension/manifest.json`, builds the Safari app and
  `dist/Bilayer-<version>.dmg`, then creates or updates the GitHub Release for that tag with the
  DMG attached. A manual `workflow_dispatch` run skips publishing and uploads the DMG as a
  workflow artifact. Supporting scripts: `scripts/assert-release-version.sh` guards the
  tag/manifest match, and `scripts/xcode-env.sh` finds a full Xcode under `/Applications`
  (`Xcode.app`, `Xcode-<version>.app`, or the runner's `Xcode_<version>.app`) when
  `xcode-select` points at CommandLineTools.

### Changed

- **Branding** — display name, popup/onboarding/diagnostics titles, and packaged app name
  are now `Bilayer`.
- **Protocol constants** — `netflix-dual-subtitles-bridge` → `bilayer-bridge`,
  `netflix-dual-subtitles-host` → `bilayer-host`,
  `netflix-dual-subtitles-native-hide-style` → `bilayer-native-hide-style`,
  `NETFLIX_DUAL_SUBTITLES_*` → `BILAYER_*`, `window.NetflixDualSubtitles` → `window.Bilayer`.
- **Icons** — `icon.svg` redrawn as two stacked subtitle bars (source blue `#4C8DFF`,
  translation amber `#FFB020`) on a dark tile. `manifest.json` now declares all seven sizes
  instead of three.
- **UI accent color** — popup and onboarding moved off Netflix red `#E50914` to `#4C8DFF`.
  The semantic `--danger` color is unchanged.
- `scripts/check.mjs` uses `fileURLToPath` instead of `URL.pathname`, so paths containing
  spaces no longer fail resolution; it also asserts `manifest.json` and `package.json`
  versions agree.
- Extracted `scripts/sign-app.sh` as the single implementation of entitlements, codesigning,
  and plugin registration, replacing the block that `install-app.sh` previously duplicated
  inline.
- **Requires macOS 12.4 or later.** `safari-web-extension-converter` sets the project's
  `MACOSX_DEPLOYMENT_TARGET` to the build machine's SDK version, which made
  `LSMinimumSystemVersion` follow whichever machine built the app. `scripts/create-safari-project.sh`
  now pins `MACOSX_DEPLOYMENT_TARGET = 12.4` for the host app and the extension: the MV3 manifest
  needs Safari 15.4+, and `optional_host_permissions` needs Safari 15.5, which ships with
  macOS 12.4.

### Fixed

- `scripts/create-safari-project.sh` silently skipped rewriting the host bundle identifier.
  The converter only quotes `PRODUCT_BUNDLE_IDENTIFIER` when the value contains a space or
  hyphen, so the quoted-only pattern matched `Netflix Dual Subtitles` but missed the
  single-word `Bilayer`, breaking the required extension-prefix relationship.

### Removed

- A stale `.env` file containing an unused API key. Nothing in the project ever read it.

### Notes

- The host bundle identifier intentionally remains `com.chinnsenn.netflix-dual-subtitles-safari`.
  Changing it would make Safari treat the extension as new and drop every existing install's
  settings, provider credentials, and site grants.
- `netflix-page-bridge.js`, the `netflix-track:` URL scheme, and the Netflix host permissions
  are deliberately unchanged: they name the target site, not the brand.
- Release builds have no Developer ID certificate, so the DMG is ad-hoc signed ("Sign to Run
  Locally") and not notarized: Gatekeeper blocks it on other Macs. Users must right-click → Open,
  or clear the quarantine attribute. See the release section of [README.md](README.md).

## [0.2.2] - 2026-09-27

### Fixed

- Japanese ruby readings: the old arbitrary-key object schema let models return `{}`. Requests
  now ask for a fixed `[{surface,reading}]` array, which the background converts into the
  reading map the overlay consumes. Legacy reading dictionaries and furigana strings are
  still accepted on the way in.
- Provider model catalog discovery and diagnostics message export.

## [0.2.1] - 2026-09-27

### Added

- Japanese furigana for the source subtitle line, generated alongside the translation and
  rendered as `<ruby>`/`<rt>` in the overlay.
- Language-aware single-line folding of hard-wrapped cues, preserving two-speaker dashes.
- Standalone onboarding wizard covering environment checks, mode selection, connectivity
  testing, and live appearance calibration.

### Changed

- Adopted a reading-map architecture for ruby: the official subtitle text is emitted
  verbatim and the model only supplies readings, which the overlay aligns.

## [0.2.0] - 2026-09-27

### Added

- Multiple translation providers, each with its own endpoint, model, and credential.
- Independent AI source track, so the translated line can come from a different Netflix
  track than the displayed native line.
- Raw request/response diagnostics panel in a dedicated wide view.
- Connectivity test and `/models` discovery for each provider.

## [0.1.3] - 2026-09-20

### Fixed

- Dual subtitles did not appear in Safari fullscreen; added the `fullscreenMount` module and
  wired it into `overlay.mount()`.

## [0.1.2] - 2026-09-20

### Added

- Safari DMG packaging script.

## [0.1.0] - 2026-08-01

### Added

- Initial Safari extension: dual native subtitles on Netflix with per-episode settings.

[Unreleased]: https://github.com/Senn-s-Team/bilayer/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Senn-s-Team/bilayer/compare/v0.3.5...v0.4.0
[0.3.5]: https://github.com/Senn-s-Team/bilayer/compare/v0.3.0...v0.3.5
[0.3.0]: https://github.com/Senn-s-Team/bilayer/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/Senn-s-Team/bilayer/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Senn-s-Team/bilayer/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Senn-s-Team/bilayer/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/Senn-s-Team/bilayer/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Senn-s-Team/bilayer/compare/v0.1.0...v0.1.2
[0.1.0]: https://github.com/Senn-s-Team/bilayer/releases/tag/v0.1.0
