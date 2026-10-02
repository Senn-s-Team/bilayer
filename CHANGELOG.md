# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Accept complete top-level JSON arrays from translation providers, including Japanese
  readings, while retaining strict subtitle count, ID, and field validation.
- Preserve actual expected/received counts in diagnostic records and distinguish count
  mismatches from other validation failures without treating unknown counts as zero.
- Copy subtitles from array responses in the diagnostics page's UI preview.

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

[Unreleased]: https://github.com/Senn-s-Team/bilayer/compare/v0.3.5...HEAD
[0.3.5]: https://github.com/Senn-s-Team/bilayer/compare/v0.3.0...v0.3.5
[0.3.0]: https://github.com/Senn-s-Team/bilayer/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/Senn-s-Team/bilayer/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Senn-s-Team/bilayer/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Senn-s-Team/bilayer/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/Senn-s-Team/bilayer/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Senn-s-Team/bilayer/compare/v0.1.0...v0.1.2
[0.1.0]: https://github.com/Senn-s-Team/bilayer/releases/tag/v0.1.0
