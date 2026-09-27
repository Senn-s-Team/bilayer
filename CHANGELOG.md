# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- `scripts/update-app.sh` no longer hardcodes a developer certificate, email address, or an
  absolute home-directory path; the streaming app path and signing identity are configurable.
- Extracted `scripts/sign-app.sh` as the single implementation of entitlements, codesigning,
  and plugin registration, shared by `install-app.sh` and `update-app.sh`, which previously
  duplicated the whole block.

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

[Unreleased]: https://github.com/Senn-s-Team/bilayer/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Senn-s-Team/bilayer/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/Senn-s-Team/bilayer/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Senn-s-Team/bilayer/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Senn-s-Team/bilayer/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/Senn-s-Team/bilayer/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Senn-s-Team/bilayer/compare/v0.1.0...v0.1.2
[0.1.0]: https://github.com/Senn-s-Team/bilayer/releases/tag/v0.1.0
