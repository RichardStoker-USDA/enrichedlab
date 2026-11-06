# Session log v1

The format the engine and Gate's Rein both read, so a session can move between the desktop, the browser and a role
agent and rebuild the same context. Agreed with the Gate side on 2026-11-06. Neither side changes its own storage:
each maps its log to v1 on export and from v1 on import.

## Envelope

`{v: 1, seq, time, kind, data}`. `seq` is per session and gap-free. Events are append-only, at most 256 KiB each.

## Shared kinds

| kind | data |
| --- | --- |
| `user` | `{text, images?: [ImageRef]}` |
| `assistant` | `{text, reasoning?, calls: [{id, name, arguments}], stop: end\|tool_use\|length\|cancelled\|error, model?}` |
| `decision` | `{callId, tool, verdict: allow\|deny\|ask\|hold, by: rule\|judge\|owner\|person, basis?: earlier\|lease, reason?, holdId?}`; a second decision answers an ask or a hold |
| `tool_result` | `{callId, tool, output, refused?, error?, images?: [ImageRef]}`; stores may cut output, so readers never assume it's whole |
| `notice` | `{level: info\|warn, text}` |
| `error` | `{text}`: why a run ended early |
| `compaction` | `{summary, through: seq}`: the summary stands in for every event up to and including `through` |

`ImageRef` is Gate's files-by-reference shape, `{uri, sha256, mime, bytes}`; a reader checks the bytes it fetches
against `sha256` (and `Repr-Digest`, where the server sends one). Image bytes never go inline.

Kinds starting with `x-` belong to one side and readers skip them. The engine's: `x-header` (the folder it worked in,
its system prompt), `x-model`, `x-place`, `x-title`, `x-checkpoint`, `x-undo`, `x-app-context`, `x-elide`.

## Rebuilding the context

1. Apply the newest `compaction`: its summary replaces the events it covers.
2. Skip unknown kinds. `decision`, `notice`, `error` and `x-*` never reach the model.
3. Each assistant turn's calls are answered by the `tool_result`s that follow. A call without one gets a stand-in:
   "The <tool> call never finished (the run was stopped)." A result for no open call is dropped.
4. To fit a budget: drop reasoning from older turns, shorten older tool output, then drop whole exchanges oldest
   first (a user message through the next one). The latest exchange always stays. When the window starts
   mid-exchange, a user turn says "(Earlier parts of this session were left out to fit the context.)"

## Engine side

`packages/engine/src/session/log_v1.ts` maps both ways; the RPCs are `session.export` and `session.import`, and the
CLI writes and reads a folder with `session.jsonl` and `images/<sha256>.<ext>`:

```sh
el session export <session id> [folder]
el session import <folder> [--cwd <project folder>]
```

Engine decisions map to `decision` events: `auto` is allow by rule, `allowed` and `allowed_session` allow by person,
`denied` deny by person, `refused` deny by rule. An engine compaction names the first event it keeps; v1's `through`
is the event just before it. `tests/session_log_v1.test.ts` checks that a log exported and imported rebuilds the same
model context.

## Rein side

Rein (Gate's web harness) serves v1 as files rather than through its event stream, since `/events` is SSE:

- `GET /rein/api/sessions/{id}/export` answers `application/jsonl`, one `{v, seq, time, kind, data}` per line.
  Rein's own decision bases map to v1 (`owner_earlier` and `owner_lease` become `owner` with a basis); kinds v1
  lacks go out as `x-rein-<kind>`.
- `POST /rein/api/sessions/import?title=&model=` takes a v1 JSONL body (an `x-rein` header line, up to 16 MiB and
  20,000 events) and answers `{session, events, skipped}`. It renumbers from 1 and remaps `compaction.through`,
  skips `x-*` and unknown kinds, drops hold ids and keeps images by reference. Imported decisions allow nothing.
- Rein rebuilds the context with the engine's summary prefix as the first user turn.
- Import limits, which every writer keeps to: a compaction's `through` names an earlier event (`0 <= through < seq`)
  and never decreases; call ids are unique within one assistant event; at most 64 calls per assistant event;
  arguments over 96 KiB are kept as `{}`; at most 20,000 records, blank lines aside. The engine's export makes
  repeated call ids unique (`<id>~2`), keeps a turn's first 64 calls and their results with a notice for the rest,
  and holds `through` steady or rising. A session longer than 20,000 records exports its newest turns, from a user
  turn, behind one leading compaction that says how much was left out (with the latest summary when there is one),
  so every export imports.

## Status

Format agreed; the engine side is built (`el session export` and `el session import`). Rein's side is built and in
review as Gate publication 60. Once it is live, one engine export goes through Rein's import and export and back
into the engine to confirm the round trip.
