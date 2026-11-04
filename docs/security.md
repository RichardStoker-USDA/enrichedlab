# Security

## What contains the agent

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Facility | Seatbelt (`sandbox-exec`) | bubblewrap, when user namespaces work | a write-restricted copy of the person's token |
| Writes | project and temp folders | project and temp folders | project and temp folders |
| Credential folders (`~/.ssh`, `~/.aws`, key stores, browser profiles) | hidden | hidden | readable |
| Network | off unless allowed | off unless allowed | open |
| Commands inside the project | run | run | ask first |
| App backends | contained as above | contained as above | run as the person (the consent card says so) |

None of these need administrator rights. Where the facility isn't available (bubblewrap inside a container, a
locked-down Windows policy), commands run as the person and every one asks first. Hiding reads and blocking the
network on Windows needs a one-time administrator setup (a sandbox account and firewall rules); a lab sandbox is the
place for that kind of work.

App backends and served apps run under the same facility with the network limited to what the app declared, and app
pages run in an opaque origin with their own content security policy (docs/apps.md). Lab sandboxes are isolated by
the lab.

The engine listens on loopback only, checks `Host` and `Origin`, and authenticates every surface (docs/architecture.md).
Keys for model services go to the OS credential store; lab tokens are owner-only files, short-lived, and bound to
the lab that issued them. At a lab that asks for it, every request also carries a DPoP proof signed by a per-lab device
key whose private half stays in the OS credential store, so a copied token is useless elsewhere ([labs.md](labs.md)).

A sandbox port opened on this computer (`<lab>_sandbox_open_port`) is a loopback proxy that adds the person's lab
sign-in to what it forwards. It answers only its own page: the Host must be its loopback address, a browser Origin its
own origin, and each request carries a per-port cookie (HttpOnly, SameSite=Strict) set from a one-time token in the
first address. Other sites in the browser and other programs get 403.

A lab sandbox's browser has none of the person's sign-ins: the engine never copies cookies into it, each session gets
its own browser context (disposed when the session or the connection ends), and it reaches only what the lab's network
policy allows. The engine connects to it through the lab's port path with the person's sign-in; the lab sends that hop
to Chrome on loopback with no Origin header. Files it downloads stay in the sandbox and leave only through the lab's
scanned file API, checked against `Repr-Digest`. A confirm or prompt on a page is cancelled, never accepted for the
person.

ChatGPT sign-in tokens stay in the engine (`~/.el/credentials/chatgpt.json`, owner-only, refreshed before they expire,
revoked at OpenAI on sign-out); windows and the terminal see only the account's email.

## Updates

Each release publishes `manifest.json` (version, notes, and every file's size and SHA-256) and an Ed25519 signature
over it. The public key is built into the binary, so a file that doesn't match what the release key signed is never
installed, wherever it was downloaded from. The private key stays on the release machine.

`el update` and the app's update button replace whatever this copy was installed as, without administrator
rights: the macOS package into `~/Applications`, the Windows setup into `%LOCALAPPDATA%\Programs`, the AppImage in
place, or the plain binary. The engine checks once a day. A release marked as a security fix installs as the app
quits, without waiting for anyone to click.

## Supply chain

- `bun scripts/deps.ts audit` checks every locked package (the workspace's `bun.lock` and the desktop's npm lock)
  against OSV and fails on any advisory that isn't triaged. Triage lives in `config/audit_accepted.json`: the
  advisory, the packages, why it doesn't reach people, and a review date after which it fails again.
- Each build writes a CycloneDX SBOM (`sbom.cdx.json`, also attached to every release).
- Dependencies are pinned exactly and taken at least two weeks after their release unless a security fix needs them
  sooner. Tools fetched at run time are pinned by hash (pixi, in `apps/environments.ts`).
- The macOS app and package are signed with a Developer ID and notarized. The Windows setup needs a code-signing
  certificate before Windows SmartScreen stops warning about it.

## AI risk management

How EnrichedLab maps to the NIST AI Risk Management Framework (AI RMF 1.0) and its Generative AI Profile (NIST AI
600-1). A lab carries its own system controls; these are the client's.

- **Govern.** Labs decide access by role (docs/labs.md). A lab that keeps data inside pins its sessions to its
  sandbox and models and removes web, personal MCP and download tools. Risk: an agent or an app acts beyond what the
  person meant. Controls: pushes always ask, commits outside the session's worktree ask, an app's permissions are
  shown and granted before its page loads, and messages from apps are marked as the app's, not the person's.
- **Map.** Each session records where it works, which model answered, every tool call with its arguments and
  result, permission decisions, and what apps told the model (`~/.el/sessions/<id>/log.jsonl`).
- **Measure.** `bun scripts/bench.ts` runs fixed tasks end to end and records pass rate, steps and time per model
  and version. The audit measures known vulnerabilities in what ships.
- **Manage.** Containment (above), undo for file edits and shell changes in a git repository, worktrees that keep
  agent work off the person's checkout, secrets redacted from logs and refused in notes and skills.

Open: input and output classifiers on the client (the lab runs its own; the client will call `POST /v1/guard` for
lab sessions), app calls in the session log, and encrypted session logs for labs that keep data inside.
