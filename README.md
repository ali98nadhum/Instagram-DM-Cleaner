<h1 align="center">Instagram Message Cleaner</h1>

<p align="center">
  Bulk-unsend your own messages from an Instagram DM conversation — a single userscript,
  no app to install, no account system, no backend.
</p>

<p align="center">
  <a href="https://greasyfork.org/ar/scripts/596008-instagram-message-cleaner">Install from Greasy Fork</a>
  ·
  <a href="#installation">Installation</a>
  ·
  <a href="#security--privacy">Security &amp; Privacy</a>
  ·
  <a href="#known-limitations">Known Limitations</a>
</p>

---

## What this is

Instagram Message Cleaner is a small userscript that runs inside your browser tab while you're
on `instagram.com/direct/*`. It finds every message **you** sent in the conversation you have
open, shows you a preview, and — only after you confirm — unsends (deletes) them in bulk. It
never touches messages sent by the other person.

There is no desktop app, no installer, no server, no login system of its own. It piggybacks on
the Instagram session you're already logged into, the same way Instagram's own web page does.

## Features

- **Scan** a conversation and see the total message count vs. how many are yours
- **Preview** a sample of what will be deleted before anything happens, with an explicit confirmation step
- **Bulk unsend** with a visible progress bar and a live, timestamped log
- **Stop** the operation at any point, mid-scan or mid-delete
- Automatic **rate-limit handling** (HTTP 429) with exponential backoff, and a conservative
  jittered delay between deletions so it behaves like a human, not a bot
- Clear error messages for network failures and expired sessions
- Only ever deletes messages where the sender is the currently logged-in user — the other
  party's messages are never touched

## How it works

Instagram's web client talks to its DM backend through an internal, undocumented **GraphQL**
API (`POST /api/graphql` with persisted `doc_id` queries) — not a public REST API. This
userscript talks to that same endpoint the same way the official web client does:

1. **Auth tokens**, all read from the current page — nothing is entered or stored by this tool:
   - `csrftoken` / `ds_user_id` — from your existing Instagram session cookies
   - `x-ig-app-id` — captured passively by watching Instagram's own `fetch()` calls
   - `fb_dtsg` / `lsd` — anti-CSRF tokens embedded in the page's inline scripts
2. **Thread identifiers** (`thread_fbid`, and the thread's numeric id used for unsending) are
   read out of the page's inline scripts, not guessed from the URL.
3. **Fetching messages**: a GraphQL query (`doc_id` for `IGDMessageListOffMsysQuery`), paginated
   with Relay-style cursors, ~2s apart.
4. **Filtering**: only messages whose `sender_id` matches your own user id are kept.
5. **Unsending**: a GraphQL mutation (`doc_id` for `IGDMessageUnsendDialogOffMsysMutation`) per
   message, with a ~3.5s base delay (increasing automatically if Instagram rate-limits you) plus
   random jitter between requests.

This approach — and the concrete `doc_id` values — was derived by studying the source code of
[uninsta](https://github.com/dustfeather/uninsta), an existing open-source project that does the
same thing as a browser extension. This project is an independent, from-scratch implementation
built as a single Tampermonkey userscript instead.

Because this relies on an internal, undocumented API, Instagram can change it at any time. If
something breaks, the log panel shows the exact HTTP status and response body to make
diagnosing and fixing it straightforward.

## Installation

This works in any Chromium-based browser (Chrome, Edge, Brave, …) or Firefox — Firefox isn't
required, it's just the path with one fewer step. The only difference between them is a single
one-time setting on Chrome-based browsers (explained below); functionally the tool behaves
identically either way.

### Firefox + Greasy Fork (fewest steps)

1. Install [Tampermonkey for Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/)
2. Open the script page: **[greasyfork.org/.../instagram-message-cleaner](https://greasyfork.org/ar/scripts/596008-instagram-message-cleaner)**
3. Click **Install**

That's it — no extra settings to change.

### Chrome / Edge (via Tampermonkey)

Chrome-based browsers require one extra *one-time* setting before **any** userscript manager
(Tampermonkey or otherwise) is allowed to run scripts, because of a Chrome policy (Manifest V3)
that applies to all userscript tools generally — it isn't specific to this project, and it
isn't a sign that something is wrong. If your friends/family already use Chrome, there's no
need to ask them to switch browsers just for this — the one extra toggle below is all it takes:

1. Install [Tampermonkey](https://www.tampermonkey.net/) from the Chrome Web Store
2. Go to `chrome://extensions`, and toggle **Developer mode** on (top-right corner) — this is a
   one-time setting; it stays on afterward
3. Open the script page on [Greasy Fork](https://greasyfork.org/ar/scripts/596008-instagram-message-cleaner) and click **Install**

### From source, without Greasy Fork

1. Install Tampermonkey (see above; enable Developer mode on Chrome/Edge)
2. Open [`userscript/instagram-message-cleaner.user.js`](userscript/instagram-message-cleaner.user.js)
   in your browser (drag the file into a tab, or `File → Open File`)
3. Tampermonkey will show an install prompt — click **Install**

The source is TypeScript ([`src/content.ts`](src/content.ts)). After editing it, install
dependencies once (`npm install`) and rebuild with:

```bash
npm run build
```

This type-checks and compiles `src/content.ts` to `dist/content.js`, then regenerates
`userscript/instagram-message-cleaner.user.js` from that output. Run `npm run typecheck` to
just type-check without emitting anything.

## Usage

1. Open `instagram.com` and log in as usual
2. Open the DM conversation you want to clean up
3. A small panel appears in the top-right corner — drag it anywhere you like
4. Click **Scan Messages** — it reads the whole conversation and shows the total message count
   plus how many are yours
5. Click **Unsend My Messages** — a preview appears with a sample of what will be deleted and an
   explicit count; nothing happens until you click **Confirm Delete**
6. Watch progress and the live log; click **Stop** at any time to halt immediately

## Security & Privacy

This project was built around one constraint above all others: **it must not become a security
or privacy liability on top of an already-sensitive task (bulk-deleting private messages).**

- **No backend.** There is no server anywhere in this project. Every network request the script
  makes goes directly from your browser to `instagram.com` — nothing is proxied, logged, or
  relayed through any third party, including the author of this tool.
- **No password handling.** This tool never asks for, reads, or stores your Instagram password.
  It authenticates purely by reusing the session cookies your browser already has from your
  normal Instagram login — the exact same mechanism Instagram's own web page relies on.
- **No custom login system.** There's no account, no signup, nothing to register for. If you're
  not logged into Instagram in that browser tab, the tool simply won't work — it doesn't try to
  work around that.
- **No analytics, telemetry, or tracking.** Nothing about your usage, your account, or your
  messages is collected, transmitted, or stored anywhere outside your own browser tab's memory.
  Closing the tab clears everything.
- **Never touches the other party's messages.** Every deletion is filtered strictly by comparing
  the message sender's user id to your own logged-in user id before it's even added to the
  delete queue.
- **Respects Instagram's rate limits.** The tool does not attempt to bypass CAPTCHAs,
  authentication, or any other security control. It applies conservative, jittered delays
  between requests and backs off automatically on HTTP 429 responses instead of retrying
  aggressively.
- **Open source, auditable.** The entire logic lives in a single readable, typed file,
  [`src/content.ts`](src/content.ts) — compiled with plain `tsc`, no bundler or minifier hiding
  what it actually does. Read it before you trust it with your account.

### What you should still know

- This tool automates interaction with an **internal, undocumented** Instagram API. Automated
  access like this is not something Instagram formally sanctions, even though no credentials are
  compromised and no security control is bypassed. Use it on your own account and at your own
  discretion.
- Bulk-deleting many messages in a short time is not typical human behavior, and platforms
  generally reserve the right to apply temporary restrictions (e.g. a short-lived action block or
  a CAPTCHA challenge) to accounts that trigger automated-behavior detection — regardless of the
  specific tool used. This project's rate limiting exists specifically to reduce that risk, but
  no third-party tool can eliminate it entirely.
- Test on a small, low-stakes conversation first before running it against something you can't
  afford to get wrong.
- This project is **not affiliated with, endorsed by, or connected to Meta or Instagram** in any
  way. "Instagram" is a trademark of Meta Platforms, Inc.

## Known Limitations

- Relies on Instagram's undocumented internal GraphQL API, including specific `doc_id` values
  captured at a point in time. Instagram can change these without notice; if it does, requests
  will start failing and the log panel will show the HTTP status and response body to help
  diagnose and fix it.
- The **App ID** is captured passively from Instagram's own network traffic and may not be ready
  the instant the page loads. If the panel shows "waiting for App ID," switch to another
  conversation and back (or refresh), then try Scan again.
- Deliberately rate-limited: deleting hundreds or thousands of messages will take a while by
  design, to stay under Instagram's abuse-detection radar.
- Operates on one open conversation at a time, not your entire inbox at once.
- If your session expires mid-run, the operation stops with a clear message — refresh and log in
  again to continue.
- No packaged Chrome Web Store listing by design (cost, review time, and rejection risk for a
  tool that automates actions on a third-party service); distributed as a userscript via
  [Greasy Fork](https://greasyfork.org/ar/scripts/596008-instagram-message-cleaner) instead.

## Project structure

```
instade/
├── src/content.ts                               # Full engine + UI — the single source of truth (TypeScript)
├── dist/content.js                              # tsc output (generated, gitignored)
├── scripts/build-userscript.ts                  # Prepends the Tampermonkey metadata header (TypeScript)
├── userscript/instagram-message-cleaner.user.js # Generated, installable userscript (plain JS — a
│                                                 #   userscript manager can only run plain JS)
├── tsconfig.json                                # TypeScript config for src/content.ts (browser)
└── tsconfig.scripts.json                        # TypeScript config for scripts/build-userscript.ts (Node)
```

## Contributing

Issues and pull requests are welcome. The whole project is one TypeScript file
([`src/content.ts`](src/content.ts)) plus a tiny build script — no framework, no bundler beyond
`tsc` itself. Run `npm install && npm run build` to get set up.

## License

[MIT](LICENSE) — do whatever you want with it, no warranty.

## Disclaimer

This tool is provided for personal, legitimate use — managing your own messages on your own
account. It is not intended for, and should not be used for, harassment, evidence destruction
where you have a legal obligation to preserve records, or any other misuse. You are solely
responsible for how you use it.
