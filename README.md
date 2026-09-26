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

If using a Netflix Mac web app, enable the extension separately in **Netflix → Settings → Extensions**; web app extension settings are independent of Safari. If the popup reports a missing or unresponsive Netflix page, verify website access in the web app, then reload the video page. The popup checks active windows and accessible Netflix tabs before reporting a disconnection.

## AI Translation (Bring Your Own Key)

1. On a Netflix watch page, choose **双原生字幕** to show two Netflix tracks, or **AI 翻译字幕** for one Netflix line and one translated line. Use **交换两行字幕及样式** to move the translation above or below the native line. Switching back to native stops translation without deleting saved tracks or AI settings.
2. In the **AI 翻译** tab, choose the source Netflix track independently of the displayed native track (a third track is allowed), the target language, and the global prompt. Set **预翻译字幕句组** to 0–50 (default 10) and **前后文各取字幕条数** to 0–4 (default 2). The current subtitle always translates first; prefetch is limited by both the chosen count and 60 seconds ahead (up to 120 seconds at higher playback speeds). Zero disables future prefetch, not current-line translation.
3. Under **翻译服务**, add or select a provider. Each provider persists its own name, model ID, compatible Base URL, and API key; the prompt and prefetch settings do not belong to a provider. An empty URL uses OpenAI; entering `https://host` or `https://host/v1` is normalized to `/v1/chat/completions`. A full `/chat/completions` URL is also accepted. Custom providers require one-time domain permission; localhost HTTP is allowed for local development.
4. Save the API key before using **测试连通性** or **获取模型**. The test sends a minimal Chat Completions request; model discovery reads the selected provider's `/models` response. **删除密钥** affects only that provider.
5. Under **诊断**, open **完整翻译日志** for lifecycle summaries. **打开原始报文面板** shows the latest requests with model, status and duration. Request and response JSON can be expanded/collapsed like a tree, including nested Chat Completions content; arrow keys navigate nodes and the path bar shows the focused field. Click a long string to expand it, or use **查看原文** for the unchanged captured body text. The latest 20 records stay in extension memory, include subtitle text, and must not be shared. API credentials never leave the background context.

Only selected subtitle text and the configured number of neighboring cues on each side are sent to the endpoint. The key remains in extension local storage and is never returned to the Netflix page or popup page-state query; local storage is **not encrypted**. The default prompt preserves meaning, character tone, names, terminology, and formatting without adding explanations. The default OpenAI endpoint uses strict JSON Schema; compatible endpoints are instructed to return `{items:[{id,text}]}`. For compatible endpoints, a bare `{id,text}` or comma-separated `{id,text}` objects are normalized before strict count, field, and ID validation; partial batches are rejected. The per-watch-session input guard stops after 80 requests or 40,000 sent characters (including context); it is not a price cap and does not count output tokens. Translations remain memory-only for the current watch session.

## Current Scope

- Switch between mutually exclusive dual-native and native-plus-AI modes; independently choose the AI source track, including a third Netflix track.
- Prioritize the current subtitle, then prefetch at most the configured future groups (default 10) inside a 60-second window (up to 120 seconds at higher playback rates); seek and episode/track changes invalidate stale results.
- Keep the prompt, languages, context and prefetch parameters global; providers own only their name, endpoint, model and credential. Unrelated storage and API keys are not page state.
- Persist subtitle selections, display settings, and provider configurations globally; translated text remains memory-only.
