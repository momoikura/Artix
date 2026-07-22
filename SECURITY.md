# Security

## Threat model

Artix is a local-first desktop application. It has no server, no account system
and no network stack — so the classic web threats (session hijacking, CSRF,
server-side injection) do not apply. What remains is worth being precise about.

### What Artix protects

**Your session archive is private data.** Transcripts routinely contain
credentials pasted into a terminal, internal hostnames, proprietary code and
customer names. Artix treats the library as sensitive by default:

- The database never leaves your machine. There is no cloud sync, no backup
  service, no crash reporter, no analytics.
- Artix does read `~/.claude/projects` on a timer when automatic sync is enabled
  (Settings → Import, on by default). That is a **local file read into a local
  database** — it is the only directory scanned, only changed files are read,
  and nothing is transmitted. Disable it for fully manual importing.
- The desktop backend links **no HTTP client**. There is no code path capable of
  making a network request.
- `.gitignore` excludes `*.db` and `.artix-data/` so a library cannot be
  committed by accident.
- Exports are explicit, user-initiated, and write only to a path you pick in a
  native dialog.

### Trust boundaries

| Boundary | Control |
| --- | --- |
| Imported file content | Parsed as data, never evaluated. No `eval`, no dynamic `import()` of user content. |
| Rendering imported text | No markdown/HTML renderer. Message bodies render as plain text with code fences as `<pre>`; a full markdown pipeline would be an injection surface for third-party content. |
| Webview → filesystem | Tauri capabilities in `src-tauri/capabilities/default.json` scope filesystem access. The asset protocol is disabled — Artix never needs to load local files into the webview. |
| Webview content | Strict CSP with no remote origins. Even a compromised frontend dependency cannot exfiltrate. |
| SQL | Every user value is a bound parameter. `list_sessions` builds `IN` clauses by concatenation, so a test fires `artix'; DROP TABLE sessions; --` through it and asserts the table survives. |
| ZIP archives | Entry paths are rejected if absolute or containing `..`, so an archive cannot write outside its root. Entries over 32 MB are skipped to bound zip-bomb memory. |
| Plugins | No network primitives are exposed. Storage access is namespaced per plugin and read-mostly; sessions can only be written through the import pipeline. |

### What Artix does *not* defend against

Stated plainly, because a vague threat model is worse than none:

- **A malicious plugin.** Plugins are JavaScript running in the same context as
  the app. The API withholds network access, but a plugin you install and enable
  can read your entire library. Only run plugins you trust.
- **Local attackers.** The database is not encrypted. Anyone with read access to
  your user account can read your archive. Use full-disk encryption if that
  matters to you.
- **Anything upstream of Artix.** If a transcript already contains a leaked API
  key, Artix will faithfully archive and index it. It does not scan for or redact
  secrets.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or email the maintainer listed in `Cargo.toml`.

Please include:

- what you did, what happened, and what you expected
- the affected version and platform
- a proof of concept if you have one

**Never include real session content.** Construct a minimal synthetic transcript
that reproduces the issue instead.

You can expect an acknowledgement within a week. If the report is valid I will
tell you the fix timeline and credit you in the release notes unless you would
rather stay anonymous.

## Scope

In scope: anything that lets untrusted input (a crafted transcript, archive or
plugin) escape its boundary — arbitrary code execution, file writes outside a
chosen path, SQL injection, or any outbound network request.

Out of scope: the absence of database encryption, plugin capabilities described
above as intentional, and issues requiring an attacker who already has your user
account.
