# Netflix Dual Subtitles Safari

macOS Safari Web Extension project for showing a second subtitle track on Netflix Web.

## Status

This is a build-free WebExtension source project. `scripts/create-safari-project.sh` auto-detects installed Xcode apps under `/Applications`.

## Structure

- `extension/`: browser extension source consumed by Safari's converter.
- `extension/src/page/`: page-world bridge that observes Netflix player metadata and subtitle requests.
- `extension/src/content/`: isolated content script, subtitle loading, parsing, timing, and overlay rendering.
- `extension/src/popup/`: extension popup for language and display settings.
- `scripts/`: local validation and Safari conversion helpers.

## Develop

```bash
npm run check   # manifest and JavaScript syntax
npm test        # content-script behavior regressions
```

## Generate Safari Project

Use the installed Xcode:

```bash
npm run safari:project
```

For a global Xcode switch:

```bash
sudo xcode-select -s /Applications/Xcode-26.5.0.app/Contents/Developer
```

Open the generated Xcode project under `SafariApp/`, enable the extension in Safari Settings, then test on `https://www.netflix.com/watch/...`.

## Current Scope

- Detect Netflix timed text metadata from page requests and load two selected text tracks.
- Render each track as soon as it loads; a slow or failed track does not block the other.
- Return only recognized display/track preferences to the popup; unrelated extension storage is not page state.
- Persist subtitle selection and display settings globally. AI translation and credentials are not implemented yet.
