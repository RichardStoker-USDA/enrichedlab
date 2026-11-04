# Labs

A lab is a server or cluster that signs people in and gives each of them models, MCP tools, a sandbox, data and apps
according to who they are. EnrichedLab reaches a lab through one adapter (`packages/engine/src/sites/`); the lab
decides access and enforces it on every call, so a changed client gains nothing the lab doesn't grant.

Run two labs with the same contract: a development lab where features are built and broken, and a production lab
that only takes what passed there.

## What a lab serves

The shapes are JSON Schemas in [contract/](../contract/); this table says what each endpoint is for. A lab names the
endpoints it serves in its descriptor, and `el lab check <lab>` exercises each one against the schemas (pass, fail or
skip per row, non-zero exit on a failure), so a lab can gate its own releases on it. Two labs serving the same contract
look the same to EnrichedLab.

| Endpoint | Purpose | Client |
| --- | --- | --- |
| `GET /.well-known/enrichedlab-lab` | the descriptor: contract version (`2026-11`), title, endpoints served, sign-in kind, policy, help and docs links, sandbox profiles | reads it on connect; refuses another contract major |
| Sign-in | OAuth 2.1 through Cloudflare Access managed OAuth: discovery (RFC 9728, RFC 8414), client registration (RFC 7591), PKCE, a token bound to the lab (RFC 8707) | built |
| `GET /v1/me` | a stable pseudonymous `subject` (never an email), memberships (lab, research group, roles), policy | built, with ETag |
| `GET /v1/models` | the models this person may use, with context, output limit and reasoning levels | built, with ETag |
| `POST /mcp` | MCP tools, filtered per person; MCP 2026-07-28 stateless, so any replica answers any request | built |
| `/v1/containers` | the person's sandbox: run, background jobs, files in and out; `profile` picks a size | built |
| `GET /v1/bundles` | skills, instructions, MCP servers and apps granted by role | built, with ETag |
| `GET /v1/events` | server-sent events with a commit-ordered `id`; resume with `Last-Event-ID`; a cursor older than the history kept gets `event: reset` | built: shown as notices; cursor kept across restarts |
| `POST /v1/guard` | the lab's classifiers: `{stage, text, session?, tool?}` → `{decision, categories, reasons, policy_version, receipt_id}` | checked by `el lab check`; sessions call it next |
| `GET /v1/usage` | tokens, GPU and sandbox seconds by lab and group, for a 7- or 30-day window | `el usage <lab>` |
| `POST /v1/devices` | registers the client's device key (ES256) for sender-bound tokens; `GET` lists them; `DELETE /v1/devices/{id}` revokes one | built: proofs on every request; `el lab check` tries a proof for another token, another address, and one used twice |
| `/v1/containers/{id}/ports/{port}/…` | HTTP and WebSocket into a port of the sandbox, header auth only, every app page served with `Content-Security-Policy: sandbox` | built: `<lab>_sandbox_open_port` opens the app in the browser pane through a loopback proxy |
| `/v1/containers/{id}/attach` | a process with stdin and output streamed over a WebSocket of JSON frames: the command first, then `{stdin}`, `{eof}`, `{signal}` in and `{stdout}`, `{stderr}`, `{exit_code}` out | built: app backends in a lab session run this way (apps.md); `el lab check` runs one |
| `/v1/apps`, `/v1/signers` | the apps a group may install, and whose signatures to trust | to add |

Tools and results carry two markers. `_meta["org.enrichedlab/tier"]: "unvalidated"` marks a tool no person has
reviewed yet: EnrichedLab shows it as unreviewed and asks before every call, in every permission mode. Data tools return
files as references (MCP `resource_link` with `_meta["org.enrichedlab/sha256"]`), never rows through the model, plus
`_meta["org.enrichedlab/receipt"]` on the result (inputs, code version, parameters, seed, image digest, outputs), so a
scientist can see how a result was made and run it again. The person saves a copy into their project with the checksum
checked.

## Who gets what

Access is decided at the lab, in three layers, and logged per person:

1. **Identity.** Cloudflare Access in front of every endpoint: the identity provider (an institution through
   CILogon, Google, GitHub), MFA, and device rules. Nothing reaches the cluster without passing it.
2. **Roles and groups.** The lab keeps memberships: a person belongs to groups (a research group, a project) with a
   role in each (reader, researcher, maintainer). Groups come from the identity provider or the lab's own table;
   explicit per-person grants add to them or take away. This is NIST's role-based model (INCITS 359) with
   attribute checks where data needs them (SP 800-162).
3. **Grants.** Roles grant tool groups, models, sandbox size and network, data scopes, and the most an app may ask
   for. The MCP endpoint lists only granted tools and checks each call; data tools pass the person's scope to the
   database (row-level security keyed on the session), so a grant can't be widened by a tool's arguments.

Least privilege by default: a new member gets reader, and every grant names an owner and a review date. The audit
record ties every model request, tool call and sandbox command to the person, the session and the grant that allowed
it.

## MCP on the lab

Serve MCP from the cluster, behind one endpoint that the lab controls. The 2026-07-28 revision made the protocol
stateless: no session to keep on a replica, each request carries its own authorization, and `server/discover`
replaces the handshake. A lab can run many copies behind a load balancer and serve many people at once, with the
same per-request checks as any API. Individual MCP servers (a database, a document search, a pipeline) sit behind
that endpoint on the cluster network, never exposed on their own; the endpoint holds their credentials and applies
the person's grants. Other MCP clients can use the same endpoint with the same sign-in.

## Cloudflare: what to use

| Feature | What it does | Cost | Use it? |
| --- | --- | --- | --- |
| Zero Trust Access, managed OAuth | sign-in, MFA and device rules in front of each hostname; OAuth tokens for apps like EnrichedLab | free up to 50 people | yes: the foundation |
| Tunnel | the cluster reaches Cloudflare outbound; no open ports | free | yes |
| MCP server portals | one address that gathers several MCP servers, with per-person access by server and request logs | in Zero Trust, beta | optional: for people using other MCP clients. EnrichedLab doesn't need it, and a portal grants whole servers, not single tools or rows, so the lab's own checks still decide |
| AI Gateway | a proxy for model providers (OpenAI, Anthropic and others) with logs, caching and rate limits | core free; log and guardrail limits | only for paid outside providers the lab offers. For models on the cluster it adds a round trip through Cloudflare and nothing the lab doesn't already do |
| Artifacts | versioned, Git-speaking storage for agents | Workers Paid, beta | no: a Git server on the cluster does the same and keeps research data on site |
| Workers (remote MCP servers) | small MCP servers at the edge | free tier | for public tools with no lab data |

**Git history** lives with the person: their repository on their computer, moved into a sandbox and back as a git
bundle. A sandbox keeps a working repository while it exists; anything that must outlive it goes to the lab's Git
server or comes home with the person.

**Tools in a website.** WebMCP lets a page register tools (`document.modelContext`) that an agent in the browser can
call. It's an origin trial in Chrome, with no other browser shipping it. When it settles, EnrichedLab's built-in
browser (Chromium) can call such tools, and lab websites can offer them; until then, lab tools go through `/mcp`.

**Notifications.** Webhooks fit server to server (Git pushes to the deploy controller, alerts to a chat). A person's
computer can't receive webhooks, so the lab streams their events over `GET /v1/events` and the app shows them.

## Keeping lab tokens in EnrichedLab

Anyone who can use a lab from their computer holds a credential there, and no client can stop a determined person
from copying it. The lab makes a copied token worth little:

- **Short lifetimes.** Access tokens last minutes and refresh; revoking a person ends both.
- **Sender-bound tokens.** For a lab whose descriptor lists `devices`, EnrichedLab makes a P-256 key per lab, keeps
  its private half in the OS credential store (an owner-only file where there is none), and registers the public half
  (`POST /v1/devices`, signed by that key). Every request, MCP included, then carries a DPoP proof (RFC 9449): `htm`,
  `htu` (the lab's public address even over the LAN), `iat`, a single-use `jti`, and `ath`, the hash of the exact
  bearer in that request. `policy.device_proof` is `off` (a lab staging the change: proofs it gets are still checked, none are asked for), `optional` or `required`. A token copied into
  another tool fails. Access doesn't issue DPoP-bound tokens, so the lab's endpoint checks the proof. On
  `device_unregistered` the client registers a new key; on `device_revoked` it stops until the person signs in again,
  so revoking a lost laptop sticks. Sign-out revokes the key (`DELETE /v1/devices/{id}`). MCP is standardizing the same
  profile (SEP-1932).
- **Quotas and alerts.** Per-person request and token limits, and an alert when use leaves the person's pattern.

## Classifiers and the audit record

Every model request and answer for a lab session passes through the lab. The lab screens prompts and answers
(policy, personal data, secrets) and screens tool results for injected instructions before the model sees them. It
records sandbox commands, keeps a hash of each event in the audit record, and keeps the full text only where policy
allows. Groups decide what their members may do with agents: which tools, whether sandboxes have network, which
models, how much. Sessions bound to a lab call `POST /v1/guard` on their own text too, so app messages and pasted
content go through the same checks.

## Sandboxes, apps and Shiny on the cluster

- **Lifecycle.** A sandbox belongs to one person. Idle for an hour, it stops: the compute is freed and its volume
  kept. Stopped for 14 days, its work is archived (the git repository as a bundle, and files not already in the lab's
  data store) and the sandbox is deleted; opening the session restores it into a new sandbox. Archives older than 90
  days are deleted after a notice, and the person can download one at any time. Nothing lingers and nothing is lost
  silently.
- **Environments.** An app's `pixi.toml` and `pixi.lock` build the same R or Python environment on a laptop and in
  the lab's image builder, so an app that runs locally runs in the sandbox.
- **Shiny and other served apps.** The app's server runs in the sandbox; the lab tunnels its port
  (`/v1/containers/{id}/ports/{port}`) and EnrichedLab shows it in a pane. The person signed in once in EnrichedLab,
  so the page needs no second sign-in in a browser.
- **Apps for groups.** A maintainer publishes a signed `.labapp` to `/v1/apps` for a group; members see it in their
  Apps menu and install it with one click. The lab says the most an app may ask for (no commands, read-only files)
  and refuses packages that ask for more. Removing a version or a signer withdraws it.

## Adding a kind of lab

A different server (a research broker, a university gateway) is one `SiteAdapter`: sign-in, models, tools, sandbox.
Register it in `SITE_KINDS` (`packages/engine/src/sites/adapter.ts`); sessions, places and apps work unchanged.
