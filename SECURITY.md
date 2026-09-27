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

API keys are stored in `browser.storage.local`, which is **not encrypted**. Keys are read
only inside the background service worker and are never returned to the popup, the
diagnostics page, or the Netflix page. Do not send a key anywhere else, and do not log
request headers that contain one.

The raw request/response diagnostics panel is opt-in and keeps the most recent 20 exchanges
in extension memory. It deliberately includes subtitle text and excludes `Authorization`,
but it does exist. If you change what it captures, keep the credential boundary intact.

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
