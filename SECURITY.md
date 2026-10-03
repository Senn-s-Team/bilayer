# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting on this repository (Security → Report a vulnerability), or
contact the maintainer directly if that is unavailable.

Include what you did, what happened, and what you expected. A proof of concept helps.

Expect an initial response within a few days. This is a small project maintained in
spare time, so please be patient with turnaround on a fix.

## Scope

The extension runs in Safari and talks to two kinds of endpoints:

- Netflix, to read the subtitle tracks the player already requests.
- An OpenAI-compatible Chat Completions endpoint that **you** configure with **your own**
  API key.

### Credential handling

API keys are stored in `browser.storage.local`, which is **not encrypted**. Translation
requests read them only inside the background service worker; page-state queries,
diagnostic records, and translation-cache provenance never include credentials. Do not
send a key anywhere else or log request headers that contain one.

Raw request/response capture defaults to enabled when a successful preference read finds
no saved value. Before that read succeeds, capture stays off; failed reads are retried.
The **Diagnostics** tab in the settings window can disable capture or clear history.
Summaries and full payloads persist in IndexedDB across background restarts. They include
subtitle text and exclude `Authorization`; there is no application-level count or age
limit, although browser quotas apply. Only the extension's settings page may query or
export this history. Clearing history does not change the capture preference.

Translation caching defaults to the current playback page's memory. Choosing device-local
caching stores source subtitles, accepted translations, annotations, and non-secret
provider provenance in IndexedDB across reloads. Local retention defaults to 30 days from
creation and 256 MiB; either limit can be disabled, subject to browser quotas. These stores
are **not encrypted**. Cache clearing and diagnostic-history clearing are separate actions.

### What is worth reporting

- A way to make the extension send an API key, subtitle text, or browsing data to an
  unintended destination.
- A way for a page to read the extension's stored credentials or internal state.
- A way to bypass the per-domain permission the user granted to a custom provider.
- Anything that lets a malicious subtitle payload escape sanitization into the page.

### Out of scope

- The fact that `storage.local` is unencrypted (documented, browser-imposed).
- The extension reading subtitle tracks Netflix already sends to the page.
- Issues that require an already-compromised browser profile or a malicious extension
  with equivalent permissions.

## Supported versions

Only the latest release is supported. Please reproduce on the current `main` before
reporting.
