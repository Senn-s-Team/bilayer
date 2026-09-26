# Netflix Dual Subtitles Safari

macOS Safari Web Extension for two Netflix subtitle lines, with optional translation through OpenAI or an OpenAI-compatible Chat Completions service.

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
npm test        # content, scheduler, store, and worker behavior regressions
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

## AI Translation (Bring Your Own Key)

1. On a Netflix watch page, choose a Netflix subtitle track for each displayed line. Either line can be set to **AI 翻译所选源语言**; the AI source is selected independently from the available Netflix track list and may be a third track.
2. Add or select a provider in **翻译服务**. Each provider persists its own name, model ID, compatible Base URL, and API key. An empty URL uses OpenAI; entering `https://host` or `https://host/v1` is normalized to `/v1/chat/completions`. A full `/chat/completions` URL is also accepted. Custom providers require one-time domain permission, and localhost HTTP is allowed for local development.
3. Save the API key before using **测试连通性** or **获取模型**. The connectivity test sends a minimal Chat Completions request; **获取模型** reads the provider's `/models` response and fills the model datalist. Both actions use the selected provider only.
4. Choose the target language from the fixed list and edit the preset translation prompt if needed. **删除密钥** only affects the selected provider. To return to native subtitles, choose a Netflix track instead of AI.
5. Open **完整翻译日志** to trace each numbered translation request through provider selection, permission, HTTP request/status and duration, response parsing, ID validation, or a specific rejection reason. Switching providers within the same episode keeps prior request logs. Diagnostics include counts and endpoint origin only; they never include API keys, subtitle text, endpoint paths, or raw upstream responses.

Only selected subtitle text and up to two neighboring cues on either side are sent to the configured endpoint. The key is kept in extension local storage and is never returned to the Netflix page or popup page-state query; local storage is **not encrypted**. The default prompt preserves meaning, character tone, names, terminology, and formatting without adding explanations. The default OpenAI endpoint uses strict JSON Schema; compatible endpoints use the standard Chat Completions request and validate the returned `{items:[{id,text}]}` payload locally. The per-watch-session input guard stops after 80 requests or 40,000 sent characters (including context); it is not a price cap and does not count output tokens. Translations are cached in memory for the current watch session only.

## Current Scope

- Choose each subtitle line independently as a native Netflix track or AI translation from a separately selected native track; a slow or failed track does not block the other.
- Prioritize the active subtitle, then prefetch translation up to 60 seconds ahead (up to 120 seconds at higher playback rates); seek and episode/track changes invalidate stale results.
- Switch among providers with separate endpoint, model, and credential; unrelated extension storage and API keys are not page state.
- Persist subtitle selections, display settings, and provider configurations globally; translated text remains memory-only.
