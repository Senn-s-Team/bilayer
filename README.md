# Bilayer

English · [简体中文](README_cn.md)

macOS Safari Web Extension for two subtitle lines on streaming video pages, with optional AI translation through OpenAI or an OpenAI-compatible Chat Completions service.

## Status

This is a build-free WebExtension source project. `scripts/create-safari-project.sh` auto-detects installed Xcode apps under `/Applications`.

## Structure

- `extension/`: browser extension source consumed by Safari's converter.
- `extension/icons/`: `icon-source.png` (1024², square, alpha) is the only hand-maintained icon source — `manifest.json` points its `1024` entry at that file itself; `npm run icons` derives every other PNG size.
- `extension/src/page/`: page-world bridge that observes Netflix player metadata and subtitle requests.
- `extension/src/content/`: isolated content script, subtitle loading, parsing, timing, and overlay rendering.
- `extension/src/settings/`: subtitle, AI translation, appearance, and provider settings, opened as a standalone, resizable window (1240×940 by default) when you click the toolbar icon.
- `extension/src/styles/`: shared design tokens (`tokens.css`) and the single control baseline (`controls.css`), loaded by the settings window, the guide, and the diagnostics page before their own stylesheets.
- `extension/src/i18n.js`: shared UI localization. A language switcher in the settings window sidebar and the guide header persists a `uiLanguage` preference (`auto` follows Safari and is the default, plus `en` and `zh_CN`) and reloads the page on change.
- `scripts/`: local validation, icon derivation, Safari conversion, signing, and release helpers.

## Requirements

- Node.js >= 22 for `npm run check` and `npm test` (no dependencies to install).
- Full Xcode for `npm run safari:project` and the build/install scripts. `npm run icons` needs macOS `sips`.

## Develop

```bash
npm run check        # manifest and JavaScript syntax
npm test             # content, scheduler, store, and worker behavior regressions
npm run icons        # regenerate 16/32/48/96/128/256/512 PNGs from icon-source.png
npm run install:app  # compile Release, sign, and overwrite /Applications/Bilayer.app
```

## Generate Safari Project

Use the installed Xcode:

```bash
npm run safari:project
```

For a global Xcode switch:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

If your Xcode app folder is named differently — for example a versioned `Xcode-<version>.app` or a beta install — substitute that folder in the path. `scripts/create-safari-project.sh` and `scripts/xcode-env.sh` already auto-detect `Xcode.app`, `Xcode-<version>.app`, and the CI runner's `Xcode_<version>.app`, so a global `xcode-select` switch is only needed when you want that choice to apply to every tool.

Open the generated Xcode project under `SafariApp/`, enable the extension in Safari Settings, then test on `https://www.netflix.com/watch/...`.

If using a Netflix Mac web app, enable the extension separately in **Netflix → Settings → Extensions**; web app extension settings are independent of Safari. If the settings window reports a missing or unresponsive Netflix page, verify website access in the web app, then reload the video page. It checks active windows and accessible Netflix tabs before reporting a disconnection.

## Release

Pushing a `v*` tag runs the **Release** workflow on `macos-latest`, which validates the version, builds the Safari app and the DMG, then publishes them to GitHub Releases.

1. Bump `version` in `extension/manifest.json`, keep `package.json` in sync, and merge to `main`.
2. Tag and push: `git tag -a v0.3.5 -m "Bilayer 0.3.5" && git push origin v0.3.5`.
3. The workflow runs `npm run check`, `npm test`, then `bash scripts/assert-release-version.sh`; the build fails when the tag (minus a leading `v`) does not equal `extension/manifest.json`.
4. It then runs `npm run safari:project` and `npm run package:dmg`, creates (or updates) the GitHub Release for that tag, and attaches `dist/Bilayer-<version>.dmg`. A manual `workflow_dispatch` run publishes no release and uploads the DMG as a workflow artifact instead.
5. `build/` and `dist/` are gitignored, so the DMG lives only in the GitHub Release or in a workflow artifact. Two tag builds never run at once (single `concurrency` group).

**Gatekeeper:** release artifacts carry an ad-hoc "Sign to Run Locally" signature and are **not notarized** — see **Signing and Gatekeeper** below to run them or to build and sign locally. The app requires **macOS 12.4 or later**: `scripts/create-safari-project.sh` pins `MACOSX_DEPLOYMENT_TARGET` for the host app and the extension, because this MV3 manifest needs Safari 15.4+ and `optional_host_permissions` needs Safari 15.5, which ships with macOS 12.4.

## Signing and Gatekeeper

CI has no Developer ID certificate, so a DMG downloaded from a GitHub Release carries an ad-hoc "Sign to Run Locally" signature and has no notarization ticket. On another Mac, Gatekeeper blocks the first launch of that app ("unidentified developer" / "damaged").

**Run the downloaded app.** macOS lets you allow this on your own machine:

1. Right-click `Bilayer.app` in Finder, choose **Open**, then confirm in the dialog.
2. Or clear the quarantine attribute first and then open it normally: `xattr -dr com.apple.quarantine /Applications/Bilayer.app`

**Build and sign it yourself.** This is a supported, first-class path: a local build is signed with your own Apple certificate and is never quarantined in the first place.

1. `security find-identity -v -p codesigning` lists the identities that can sign; if none is installed, `scripts/sign-app.sh` falls back to ad-hoc `-` and you are back in the downloaded-DMG situation.
2. Build, sign, and install in one command — `scripts/sign-app.sh` automatically uses the first local `Apple Development` identity: `npm run install:app`
3. Override the automatic choice with an explicit certificate: `CERT_NAME="Apple Development: you@example.com (XXXXXXXXXX)" npm run install:app`

**Check what you actually got.** Both commands ship with macOS:

1. `codesign -dv --verbose=4 /Applications/Bilayer.app` — a build signed with your certificate lists `Authority=Apple Development: you@example.com (XXXXXXXXXX)` and your own `TeamIdentifier`; a CI download instead reports `Signature=adhoc` and `TeamIdentifier=not set`.
2. `spctl -a -vvv -t exec /Applications/Bilayer.app` — prints `rejected` for both, because neither an ad-hoc nor an `Apple Development` signature is a notarized distribution signature; a build signed with your own certificate adds `origin=Apple Development: you@example.com (XXXXXXXXXX)`, while the ad-hoc download prints a bare `rejected`. A locally signed build still opens because it was never quarantined; only a notarized Developer ID build reports `accepted` with a `source=` line.

Producing a download that passes Gatekeeper on someone else's Mac requires all three of: a **Developer ID Application** certificate, a `xcrun notarytool submit` submission, and `xcrun stapler staple`. This repository does none of them and keeps no certificate secret in CI, so GitHub Release artifacts stay ad-hoc signed.

## AI Translation (Bring Your Own Key)

1. On a Netflix watch page, choose **Dual native subtitles** to show two Netflix tracks, or **AI translation** for one Netflix line and one translated line. Use **Swap the two subtitle lines and styles** to move the translation above or below the native line. Switching back to native stops translation without deleting saved tracks or AI settings.
2. AI translation needs **both** a Netflix subtitle track and a configured provider. When Netflix publishes no subtitle tracks for the title, neither dual native subtitles nor AI translation can show a line: the settings window marks the **AI translation** card as unavailable, explains why under the mode cards and at the top of the **AI Translation** tab, disables the AI source-track select, and clicking that card opens the explanation instead of doing nothing; the overlay shows the same hint at the subtitle position. Selecting AI is blocked in that state, but a previously saved AI choice is kept rather than silently reverted to native and applies again on a title that has subtitles — play one of those. When AI mode is on but no provider is configured, the settings window shows **AI translation needs a translation service** with a link to the **Translation Services** tab (the overlay hints the same at the subtitle position): add an endpoint and API key there. Both notices follow the settings window's existing state poll, so they disappear as soon as a provider is configured or a title with tracks is playing; while the tracks are still unknown nothing is claimed. If the extension still cannot read the player's track list after a short wait, the state becomes **tracks unread**: the settings window shows a softer notice that says the tracks could not be read — not that the title has none — points to refreshing the page or playing another title, and keeps **AI translation** selectable; only a definitive **no tracks** blocks AI.
3. In the **AI Translation** tab, choose the source Netflix track independently of the displayed native track (a third track is allowed), the target language, and the global prompt; the **Active translation service** selector at the top of the tab picks which already-added service translates, and stays in sync with the **Translation Services** tab in both directions. Set **Pre-translate subtitle groups** to 0–50 (default 10) and **Context subtitles per side** to 0–4 (default 2). The current subtitle always translates first; prefetch is limited by both the chosen count and 60 seconds ahead (up to 120 seconds at higher playback speeds). Zero disables future prefetch, not current-line translation. Next to those fields, **Request cap** (default 80) and **Character cap** (default 40,000) bound how much input may be sent, **Cap accounting window** picks the period they are counted over (**This watch session**, **This hour**, or **Today**), and the readout under them names that window and shows the requests and characters used so far; setting `0` makes either cap unlimited.
4. Under **Translation Services**, add or select a provider — the same choice as the AI page's **Active translation service** selector. Each provider persists its own name, model ID, compatible Base URL, and API key; the prompt and prefetch settings do not belong to a provider. An empty URL uses OpenAI; entering `https://host` or `https://host/v1` is normalized to `/v1/chat/completions`. A full `/chat/completions` URL is also accepted. Custom providers require one-time domain permission; localhost HTTP is allowed for local development.
5. Save the API key before using **Test connection** or **Fetch models**. The test sends a minimal Chat Completions request; model discovery reads the selected provider's `/models` response. **Delete key** affects only that provider.
6. Open **Diagnostics** from the settings window; the **Raw translation payloads** page lists the latest requests with model, status and duration. Request and response JSON can be expanded/collapsed like a tree, including nested Chat Completions content; arrow keys navigate nodes and the path bar shows the focused field. Click a long string to expand it, or use **Toggle tree view** to switch between the parsed tree and the unchanged captured body text. The latest 20 records stay in extension memory, include subtitle text, and must not be shared. API credentials never leave the background context.

Only selected subtitle text and the configured number of neighboring cues on each side are sent to the endpoint. The key remains in extension local storage and is never returned to the Netflix page or settings page-state query; local storage is **not encrypted**. The default prompt preserves meaning, character tone, names, terminology, and formatting without adding explanations. The default OpenAI endpoint uses strict JSON Schema; compatible endpoints are instructed to return `{items:[{id,text}]}`. For compatible endpoints, a bare `{id,text}` or comma-separated `{id,text}` objects are normalized before strict count, field, and ID validation; partial batches are rejected. The input guard stops at **Request cap** (default 80 requests) or **Character cap** (default 40,000 sent characters, including the neighboring context lines, so a larger **Context subtitles per side** burns the character cap faster); `0` removes that cap, the two caps are enforced independently, and the settings window shows live usage against both, names the cap that stopped translation, and states which window the count covers. **Cap accounting window** defaults to **This watch session**: that window is the current watch page and it survives a reload of the same episode, while **This hour** and **Today** are local-time buckets. Usage is persisted in extension storage under a key that identifies the accounting window rather than held in memory, so a reload or reopening the settings window continues that window's count. Changing a cap or the window mid-session takes effect at once: raising a cap resumes translation without discarding lines already translated, and lowering it below what has been consumed stops new requests immediately. This is an input guard, not a price cap: it counts neither output tokens nor cost, and a real cost budget would additionally need the response `usage` and a per-model price table. Translations remain memory-only for the current watch session.

## Current Scope

- Switch between mutually exclusive dual-native and native-plus-AI modes; independently choose the AI source track, including a third Netflix track.
- Prioritize the current subtitle, then prefetch at most the configured future groups (default 10) inside a 60-second window (up to 120 seconds at higher playback rates); seek and episode/track changes invalidate stale results.
- Keep the prompt, languages, context, prefetch, and input-cap parameters global; providers own only their name, endpoint, model and credential. Unrelated storage and API keys are not page state.
- Persist subtitle selections, display settings, provider configurations, and cap usage globally; translated text remains memory-only.

## Privacy

The extension reads the subtitle tracks the Netflix player already requests, and sends only the
selected subtitle text plus the configured neighboring cues to the endpoint **you** configure.
API keys live in extension local storage, which is **not encrypted**, and are read only inside the
background service worker. The opt-in diagnostics panel keeps the latest 20 request/response pairs
in extension memory, including subtitle text, and never captures `Authorization`. See
[SECURITY.md](SECURITY.md) for the full boundary and how to report a problem.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm run check && npm test` is the whole gate; CI runs both
on Node 22 and 24. Notable invariants: keep `extension/manifest.json` and `package.json` versions in
sync, do not change the bundle identifier casually, and keep third-party trademarks out of the name,
icon, and metadata.

## Credits

Parts of Bilayer deliberately follow outside work. This section records only the references the
repository itself documents, together with the parts that are reimplemented rather than copied.

### Design references

- Film-subtitle constraints — keeping every cue's ID and its context boundaries intact through
  translation — are recorded in the project changelog as borrowed from 沉浸式翻译 / Immersive
  Translate (`CLAUDE.md`, changelog entry `2026-09-26`). No code or subtitle text from that
  project is included here.
- The diagnostics JSON viewer's interaction — foldable tree, keyboard path navigation, long-string
  expansion — is recorded as "借鉴 fx" (`CLAUDE.md`, changelog entry `2026-09-26`). The changelog
  names an interaction style only, not an upstream project or version, so it is credited as an
  interaction-style reference rather than as a code dependency.
- The extension pages use the macOS/Apple typography and motion language as a generic design
  language: the `-apple-system`/`SF Pro` font stack (the shared `--bl-font-sans` token in
  `extension/src/styles/tokens.css` line 110) and the spring easing (`--bl-ease-spring` and
  `--bl-ease-springy` in the same file, lines 149 and 152, used for example in
  `extension/src/settings/settings.css` lines 303 and 399 and `extension/src/onboarding/onboarding.css`
  line 109). This is styling, not code from Apple.
- Netflix player integration is reimplemented from observed behaviour: the page bridge hooks the
  watch page's own `JSON.parse`, `fetch`, `XMLHttpRequest`, and resource timing to see the
  subtitle tracks the player is already requesting, and the content side resolves them through
  its own `netflix-track:` URL scheme (`extension/src/page/netflix-page-bridge.js`,
  `extension/src/content/netflixAdapter.js`, `extension/src/content/subtitleStore.js`). No Netflix
  source code, subtitles, or artwork is used anywhere.
- The Chat Completions contract is implemented from the public API shape: a strict `json_schema`
  request (`subtitle_translations`) for the default OpenAI endpoint, plus tolerant normalization
  of malformed compatible-provider replies. The `cases/` fixtures that drive that parsing are
  sanitized captures — the structural malformations are kept and the subtitle text is synthetic
  (`cases/CLAUDE.md`).

### Tools and platforms

- `xcrun safari-web-extension-converter` generates the Xcode project from this WebExtension
  source.
- `sips` derives every non-master icon PNG from `icon-source.png`.
- `plutil` reads the manifest version in the packaging and release scripts.
- `/usr/libexec/PlistBuddy` adds the `SafariExtensionBundleIdentifier` key to the generated host
  app.

### Third-party code

- No third-party source is vendored. `package.json` declares no `dependencies`,
  `devDependencies`, or `optionalDependencies`; there is no lockfile, no `node_modules/`, and no
  file under `extension/` imports a bundled library.
- No third-party fonts or imagery ship with the extension: `extension/` contains no `.woff2`,
  `.ttf`, or `.otf` files, and the only images are the project's own icons.
- `LICENSE` is plain MIT covering the project's own source; there is no third-party license
  notice to reproduce.
- The trademark boundary is deliberate: no third-party mark appears in the name, icon, or
  metadata, while `netflix-page-bridge.js`, the `netflix-track:` scheme, and the Netflix host
  permissions name the target site rather than the brand.

### Assets

- The icon artwork is maintainer-supplied. `extension/icons/icon-source.png` is the only
  hand-maintained image, and every other PNG is derived from it by `scripts/build-icons.sh`; no
  upstream art or licence is involved.

## Roadmap

A plan, not a promise: nothing below is scheduled or attached to a version.

### Chromium and Firefox

The verdict differs per engine: current Chromium runs this extension unmodified, while Firefox is
a small-to-medium porting job rather than a rewrite.

Verified by a real load (Chrome for Testing 153.0.8010.12, unpacked `extension/`, driven over CDP):

- The unmodified `extension/` loads with no manifest or console errors, and the settings page renders
  with its four tabs, its localized text, and the stored settings (`enabled` on, interface language
  `auto`).
- A background round trip from the settings page is answered: `BILAYER_TRANSLATE_BATCH` with an empty
  batch returns `{ok:false,errorCode:"configuration"}`.
- Content scripts boot on a Netflix watch URL: the overlay host and the native-subtitle hiding
  style are mounted, and the main-world bridge installs through the web-accessible-resource
  script.
- The `_locales` read path `i18n.js` uses works: a synchronous XHR of
  `runtime.getURL('_locales/zh_CN/messages.json')` returns 200.
- No Chromium code or manifest change is required. Branded Chrome no longer accepts the
  `--load-extension` testing flag — Bilayer does not load there at all — so testing uses Chrome
  for Testing or "Load unpacked"; that is a testing limitation, not a porting one.

Verified by reading the code:

- `extension/manifest.json` declares MV3 `background.service_worker` and no other background
  form, and no `browser_specific_settings` (or `gecko.id`) exists anywhere in the repository.
- `optional_host_permissions` is declared, and the permission prompts are requested from
  extension pages with `runtime.permissions.request` synchronously inside their click handlers,
  so the user-gesture requirement is already met as written.
- The diagnostics buffer and its version and sequence counters are mirrored into `storage.local`,
  so records and their IDs survive a service-worker restart; the capture toggle
  (`__raw_capture_enabled__`) is persisted alongside those keys and the worker reloads it before
  any capture decision, so a user who turns raw capture off stays off across a worker restart. That
  preference is unknown-until-read: a read that fails leaves capture off and is retried by the next
  request, so a storage error can never silently turn capture back on.
- The worker holds no `setInterval`, keepalive, or alarm; its only timers are per-request fetch
  aborts, so nothing else assumes a resident worker.
- `web_accessible_resources` already uses the MV3 object form, and the locale bundles
  `_locales/en` (the declared `default_locale`) and `_locales/zh_CN` have matching key sets.

Not verified — assumptions and unexercised paths:

- Firefox was never launched: no Firefox binary exists on this machine, so every Firefox item
  here is derived from the manifest, the code, and documented engine behaviour rather than from
  an observed run.
- Firefox MV3 does not implement `background.service_worker`, so an event page
  (`background.scripts`) is required; declaring both keys can also change which background
  context Safari picks, which turns "one shared manifest or a per-engine transform" into a real
  decision.
- Firefox's manifest host permissions are opt-in and revocable at install time, and a declined
  grant silently stops the content scripts; the current code only probes reachability with
  `tabs.query`, so a recovery path would be new work.
- Whether Firefox shares `window.Bilayer` across content scripts the way Chrome does is
  unverified; if it does not, renaming it to `globalThis.Bilayer` becomes mandatory.
- Not exercised in either engine: the real user-gesture permission prompt, a logged-in Netflix
  watch page (overlay, fullscreen, real CSP), service-worker eviction under sustained load, and
  store review outcomes.

Work this implies:

- Firefox: add `background.scripts`, `browser_specific_settings.gecko.id`, and the add-on store's
  data-collection declaration, then re-verify the content-script globals and the permission flow
  with real clicks.
- Firefox: add a host-permission recovery path (`permissions.contains` plus
  `permissions.request`) so a declined Netflix grant is recoverable.
- Decide between one shared manifest and a per-engine transform, because the Safari
  background-context preference above depends on that choice.
- Chromium needs no porting work; what remains there is optional hardening (declaring
  `downloads`, which the diagnostics export already falls back from) and store packaging, which
  is separate review work per store.

### Additional video sites

- This is the largest item on the list. The bridge and the adapter are Netflix-specific:
  `content_scripts` matches `netflix.com` only, the injected bridge is `netflix-page-bridge.js`,
  and the private player fields are isolated in `extension/src/content/netflixAdapter.js`. Each
  additional site needs its own observation bridge and adapter; the parser, scheduler, and
  overlay are already platform-independent.

### Documentation and screenshots

- There is no `docs/` folder yet. Screenshots (the overlay in dual-native and AI modes, the settings
  window appearance panel, the diagnostics payload view) need a hosted location and maintainer-supplied
  captures before they can be linked from these READMEs.
- A short recording of the dual-line overlay would document the appearance settings better than
  prose.
- The `cases/` fixture set can grow with further sanitized malformed-response captures; the
  redaction rule is in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).
