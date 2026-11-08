**English** · [简体中文](./README.zh.md)

# dsh-session-send

A session bus for DSH: lets **independent DSH sessions / agents send messages to each other** and wake each other up — no human copying prompts between windows.

Modelled on the *approach* of OpenClaw's `session send`, built as a DSH plugin.
**Off by default.** It only takes effect inside a project you explicitly enable.

> **This is not an OpenClaw plugin.** It runs inside the DSH host and **never reads or writes `openclaw.json`**,
> does not read OpenClaw's session ledger, and registers no channel. What it borrows is the *message semantics*,
> not OpenClaw's configuration or data plane.

---

## Message semantics (aligned with openclaw `session send`)

```ts
send({ from, to, kind, payload, replyTo?, deliveryMode? })

// to           : session id | registered name | dsh-team member name | "*" (broadcast)
// kind         : text | request | response | event
// deliveryMode : steer (default) | followup | notify
// payload      : { text, data? }
// replyTo      : message id being answered, when kind=response
```

### The point: the message actually wakes the other session

This is not "write to a database and hope someone polls it". When the target is a live DSH session,
the message goes straight into **that session's own inbox** and wakes it — the same behaviour as
openclaw's `session send`.

| openclaw `mode` | this plugin `deliveryMode` | DSH call | behaviour |
|---|---|---|---|
| `notify` | `notify` | `agent.inject(msg)` | deposit only, no wake |
| `steer` | `steer` (default) | `agent.steer(msg)` | inject into the running turn at the next step boundary, and wake |
| `followup` | `followup` | `agent.followup(msg)` | queue as the next turn, and wake |

The host implementation of `agent.steer()` is `this.inbox.splice(target, Infinity, 0, [message])`
plus `wakeDriver()` — it appends directly to the target session's own inbox with **no parent/child check**.
That is why N independent, peer-level sessions can message each other freely; nobody has to be anyone's subagent.

### When the target is not in this process

The message is still persisted. It is delivered when the target session is opened again, and can be
read with `dsh_bus_inbox`. Delivery never silently drops a message: a missing target raises
`E_TARGET_NOT_FOUND`, an ambiguous one raises `E_AMBIGUOUS_TARGET`.

### Measured on a real host (2026-11-08)

```
beforePhase: idle  →  afterPhase: running
delivery:    { mode: "steered", detail: "已注入并唤醒目标" }
markerSeq:   1684          // the message landed in the target's event stream
reply:       "B2已收到"     // the target read it and answered
toolCalls:   []            // and touched no files doing so
```

---

## Typical use: several sessions sharing one project

You have a project split across several sessions — pipeline, chapter runner, gate, and so on.
One session discovers it needs another to continue. Instead of asking a human to carry the prompt over:

```js
// in the "pipeline" session
dsh_bus_send({ to: "gate", text: "Chapter 3 is done — please review." })
```

The gate session wakes up, reads the message, and starts working.

## How the project root is resolved

**Resolved per call, from the caller** — never pinned at mount time.

Priority: explicit config `projectRoot` > the calling session's `cwd` > current initiator's `cwd` > process `cwd`.

Why it has to work this way: the host is long-lived and holds sessions from several workspaces.
Whichever session happened to trigger mounting at startup must not decide which project's config every later call reads —
otherwise a session in project A would send messages using project B's enable switch.

A real bug this fixed: at startup `currentInitiator()` is empty, so the root fell back to `process.cwd()`
(the profile directory). Every later call then looked for `.dsh-bus.json` there and reported
"project not enabled" even though the real project had one.

## Enabling a project (no hand-editing)

Open the **Session row's "..." menu** in the left sidebar and click the bus entry.
It writes `<workspace>/.dsh-bus.json` and takes effect immediately; click again to turn it off.
The menu shows the current state (on / off) for that session's project.

Only one file is ever written, and only its `enabled` field:

```json
{
  "enabled": true,
  "transport": { "kind": "sqlite" },
  "scope": "project"
}
```

A corrupt config is never overwritten — the plugin refuses and reports why.

### Why the switch lives on the Session row, not the project row

`ui-workspace`'s project-row menu is a hardcoded `[rename, delete]` with no extension slot.
The session row does have one, so the switch lives there and acts on **that session's project**.

## Configurable fields

| field | default | notes |
|---|---|---|
| `enabled` | `false` | per-project switch |
| `transport.kind` | `'sqlite'` | `sqlite` / `file` / `in-process` |
| `registry.sources` | `['dsh-team','dsh-sessions']` | which registries to expose |
| `registry.stateDir` | `'.agent-teams'` | dsh-team state directory name |
| `registry.requireRegistration` | `true` | unregistered sessions are invisible and unaddressable |
| `router.allowBroadcast` | `true` | allow `to: "*"` |
| `router.maxPayloadChars` | `20000` | payload size ceiling |
| `router.dshTeam.target` | `'auto'` | `auto` / `service` / `mailbox` |
| `labels` | `{}` | optional name overrides: `{ "<session id>": "gate" }` |
| `ui.entry` | `true` | show the sidebar entry |
| `ui.pollMs` | `4000` | panel poll interval |

## The reply guard: a missed reply cannot pass silently

A real failure: six messages sent, all returned `steered`. Only one reply came back. The other
four sessions **had received and processed them** — their event streams show the message, a full
turn, and a written answer — but they wrote the answer into their own conversation and never
called `dsh_bus_send`. To the sender it looked like delivery had failed.

Putting "call this tool to reply" in the message text is still only a reminder. The plugin
intervenes at the host's own turn boundaries instead:

| step | host event | what the guard does |
|---|---|---|
| 1 | `agent/inbox/claimed` | a bus message leaves a session's inbox → record a debt: this session owes that sender a reply |
| 2 | `tools/result` | `dsh_bus_send` / `dsh_bus_reply` addressed at the creditor → settle the debt |
| 3 | `agent/turn-stopping` | the turn is about to close with no live tool calls, and a debt remains → inject a nudge into that session's own inbox and wake it, so it runs another turn and actually replies |

Deliberate limits:

- **It nudges, it never answers on the session's behalf.** A fabricated reply would be worse than
  a missing one.
- Only messages this plugin delivered are tracked (`source.origin`), so ordinary human turns are
  never touched.
- Each debt is nudged at most twice, then dropped with a warning — no infinite loop.
- The nudge text offers an explicit "no reply needed" exit.

## Message header

A delivered message reads as a message, not a log line. The sender is a name, not a uuid:

```
📨 来自 管线维护 的消息

第三章就绪，请复核。
---
回复：dsh_bus_reply({ replyTo: "...", text: "..." })
或：  dsh_bus_send({ to: "管线维护", text: "..." })
（只在你自己这一轮里回答不算回复 —— 发送方看不到）
不需要回复就忽略本段。
message_id=...
```

The technical identifiers (`message_id`, `reply_to`) sit at the bottom next to the reply
instructions, where they are actually needed as tool arguments — not in the reader's face.

## Naming sessions: self-registration (recommended)

DSH session titles are generated asynchronously, and most historical sessions have none —
a bus list would show only uuids. **Nobody should have to maintain an id table by hand.**
Let each session register itself once:

```
# in the "pipeline" session:
dsh_bus_register({ name: "pipeline" })

# in the "gate" session:
dsh_bus_register({ name: "gate" })
```

After that:

- the list shows those names
- others can address them directly with `dsh_bus_send({ to: "gate", text: "..." })`
- the registry lives **inside the project** at `.dsh-bus/names.json` — never global, never leaked across projects
- it takes effect immediately; no restart, no config editing

Clear a registration with `dsh_bus_register({ name: "" })`.

## Registration means participation

**Registering is not just naming — it is how a session joins the bus.**

A project switch decides whether the bus works at all. Which sessions appear on it is a
separate, explicit decision:

| | unregistered session | registered session |
|---|---|---|
| appears in `dsh_bus_agents` | no | yes |
| addressable by name | no | yes |
| addressable by raw session id | **no** | yes |
| can be delivered to | no | yes |
| nudged by the reply guard | no | yes |

Measured on one real project: 121 sessions, 7 of them doing the actual work. Listing all 121
buried the real lanes and made it easy to message the wrong session — so the default is strict.

Small projects can opt out with `registry.requireRegistration: false`, which makes every
session in the project addressable. `dsh_bus_agents` still reports only participants;
diagnostics can use the internal `listAll()` to see everyone.

**A new session learns who it is on first contact.** The first message delivered to a session
is prefixed with a short introduction — its own bus name, the roster of other participants,
and how to reply. It appears exactly once per session per project (`.dsh-bus/greeted.json`),
and the roster excludes the reader, so nobody is invited to message their own session.

**Batch form** (initialise a whole project in one call):

```js
dsh_bus_register({
  selfName: "pipeline",                                  // ← name YOURSELF too
  entries: {
    "session-4c72b65e-da51-4a5f-999d-e9551e9f8dca": "cast",
    "session-da38f11a-5982-4d2c-bc3d-c5381400cf88": "outline",
    "session-54288ce6-ac61-446b-95ef-de3d2fe6fcb7": "gate"
  }
})
```

> **`entries` does not include you.** A batch registration names the sessions you list and nothing else —
> the calling session stays unnamed unless you pass `selfName` (or list your own id in `entries`).
> The response reports `callerNamed` and a warning when you are still unnamed after the call.
> This is a real trap: a batch call that names six lanes and forgets the caller looks successful
> and leaves the caller invisible in the list.

Returns `applied`, `rejected` (ids from another project are rejected with a reason), `callerNamed`, and `warnings`.

**Display-name priority: registered name > config `labels` > host title > fallback label (`11-08 15:49 · e9f8dca`)**

### What may be used as a `to` target

| valid `to` | notes |
|---|---|
| **session id** | unique, stable, never changes — **the reliable key** |
| registered name | bound to the session id |
| config `labels` name | bound to the session id |
| host title | a real host field |
| `"*"` | broadcast to other sessions in this project |

**The fallback label (`11-08 15:49 · e9f8dca`) is NOT addressable.**
It is a *derived* display string built from the id and its creation time, not an identity.
Treating it as a key would let a derived value impersonate an identity, and it would break the
moment the display format changed. It exists for humans to tell rows apart — use the session id
(or have the target register a name) when you actually send.

## Project isolation

The plugin is mounted profile-wide (it has to be, or it could never decide anything), but
**who can see and reach whom is strictly per-project**:

- the registry lists only sessions of the current project
- `resolve` refuses targets from another project (`E_TARGET_NOT_FOUND`)
- each project keeps its own `.dsh-bus/` store and `names.json`
- dsh-team state is read only from inside the project root

Nested projects resolve to the **most specific** project root: `...\SOP\loop` sits under
`D:\openclaw-data`, but once `loop` has its own `.dsh-bus.json` its sessions belong to `loop`,
not to the outer project.

### A brand-new project

Nothing is hardcoded to any project — a project that has never used the bus simply starts empty.
Two independent switches decide whether it works:

1. `<workspace>/.dsh-bus.json` with `enabled: true` — created for you by the sidebar session menu.
2. Each session registers itself: `dsh_bus_register({ name: "..." })`.

Until both are true the project has no addressable sessions. That is intentional: it is what
keeps unrelated sessions from being disturbed. And the empty state is never silent — calling
`dsh_bus_agents` in an unenabled project answers with the project path and the reason, not a
bare `0`.

## Four decoupled layers

| layer | file | replaceable |
|---|---|---|
| transport | `src/transport/*` | `sqlite` / `file` / `in-process`, same interface |
| registry | `src/registry/*` | `dsh-sessions` + `dsh-team`, via a composite |
| router | `src/router/*` | delivery semantics, broadcast, dedupe |
| ui | `src/ui/*` | sidebar panel, badges, session-row menu |

## dsh-team (AgentTeams) integration

The adapter only *wraps* `@nanmicoder/dsh-agent-teams` — it never forks or copies it.
Delivery uses that package's own `appendMailbox` / `deliverToMember`, so the message format in
`inbox/*.jsonl` is byte-for-byte what dsh-team writes itself.

## Storage

Everything lives **inside the project**:

```
<workspace>/.dsh-bus/bus.db        # messages + receipts (sqlite)
<workspace>/.dsh-bus/names.json    # self-registered names
```

Not in any shared host database — a project's messages stay in that project.

## Model-facing tools

| tool | purpose |
|---|---|
| `dsh_bus_send` | send `{to, text, deliveryMode?, kind?, data?, replyTo?, from?}` |
| `dsh_bus_inbox` | read messages addressed **to you** (+ unread counts); `direction: "outbox"` for what you sent |
| `dsh_bus_agents` | list addressable sessions **of this project** + per-source availability |
| `dsh_bus_reply` | answer a message (`kind=response` + `replyTo`; recipient taken from the original) |
| `dsh_bus_register` | **name yourself**: `{ name: "pipeline" }`, then others can `to: "pipeline"` |

## Troubleshooting: the sidebar switch is missing

The project switch lives in a Session row's "..." menu. It is a client-half UI entry,
so a missing row is never a server/transport problem. Four independent layers had to
be right; each one failed silently, which makes this section worth keeping.

Check them in this order — all four are now fixed, and there are tests for each of the
manifest/route assumptions:

| # | symptom | cause | fix |
|---|---|---|---|
| 1 | no client code runs at all | `package.json` had no `exports["./client"]`; `dsh-client-modules` cannot locate a client bundle without it | declare `"."`, `"./client"`, `"./package.json"` in `exports` |
| 2 | bundle loads but registers nothing | `apply(ctx)` used the **host-side** contract `ctx.inject(['slots'], cb)`. The client runner puts services directly on `ctx` | use `ctx.slots` / `ctx.layout` |
| 3 | row shows "状态未知" in one session, vanishes in another | component consumed host-injected `useSessions` / `useMenuOpenState` / `MenuItemButton` props; a host hook outside a React render throws `Invalid hook call`, swallowed by `reportEntryError` | client reads **no** host props: host route `/whoami?session=<id>` resolves `projectRoot` + switch state; component uses only React's own hooks + a native `<button>` |
| 4 | still intermittent | `slots.register` chain (`guardedSlots` → `env.claim` → `reportEntryError`) drops entries at runtime with no visible error | primary path is a **ctx-free DOM fallback**: capture `sessionId` from `data-row-key="session:<id>"` on `pointerdown`, then a `MutationObserver` inserts a native menu row when `[role="menu"]` appears. Same route as other working session-menu rows. `slots.register` remains as a secondary path |

Two traps that are easy to miss:

- **Do not declare a service in the factory's `inject` unless it exists on the
  client.** An unavailable service can park the whole package before `apply` runs.
  This package declares only `['slots']`.
- **Do not rely on the installer's "client 跳过（无 client 声明）" line.** It reads
  like an expected skip; it actually means the loader failed to find the client
  bundle. Every UI-capable plugin in the profile has `exports["./client"]`.

Quick diagnosis:

```bash
# 1. manifest shape
grep -n '"./client"' package.json

# 2. is the client bundle actually served?
curl -s http://127.0.0.1:<port>/plugins/??dsh-session-send/client.js | head -5

# 3. does the host know the session's project?
curl -s "http://127.0.0.1:<port>/plugins/dsh-session-send/whoami?session=<session-id>"
```

If (3) returns `projectRoot` and `project.enabled`, the menu row has everything it
needs. The desktop app is Electron running this same web surface, so there is no
separate native menu path to configure.

## Install

```bash
dsh plugin add https://github.com/nevercanner/dsh-session-send
```

**npm 12 blocks git dependencies by default** (`allow-git=none`). If the install fails with
`EALLOWGIT`, either pass the flag through or set it once:

```bash
npm config set allow-git all      # or: dsh plugin add ... --allow-git=all
```

The repository builds itself on install (`prepare` runs `scripts/build.mjs`), so a source install
needs no prebuilt artifact — only Node >= 22.18.0, which is what the host already requires.

## Development

```bash
npm run build      # src/*.ts → lib/*.js (via node:module.stripTypeScriptTypes, no tsc needed)
npm test           # 176 tests
npm run typecheck  # needs tsc locally
```

Test groups:

| file | covers |
|---|---|
| `tests/router.test.mjs` | routing semantics (unicast/broadcast/replyTo/unread/error codes) |
| `tests/config.test.mjs` | config validation and project config loading |
| `tests/transport.test.mjs` | the three transports against one contract |
| `tests/dsh-team-adapter.test.mjs` | dsh-team wrapping, not copying |
| `tests/plugin.test.mjs` | mount integration (fake host) |
| `tests/control.test.mjs` | the project switch writer (flips only `enabled`, refuses corrupt config, atomic write) |
| `tests/switch.test.mjs` | end-to-end switch (click → write → hot effect) |
| `tests/routes.test.mjs` | route registration tolerance |
| `tests/session-push.test.mjs` | **cross-session delivery** (peer sessions) |
| `tests/project-resolution.test.mjs` | **per-caller project root** (regression) |
| `tests/dsh-team-resolve.test.mjs` | **dsh-team package resolution** (junction + missing `DSH_PROFILE_DIR`) |
| `tests/session-resume.test.mjs` | inactive-session cold start |
| `tests/json-safe.test.mjs` | **lossless JSON** for tool output |
| `tests/project-isolation.test.mjs` | **project isolation** and nested projects |
| `tests/inbox-and-labels.test.mjs` | inbox vs outbox, display names |
| `tests/self-register.test.mjs` | **self-registration** and addressable keys |
| `tests/message-loop.test.mjs` | **message loop** — header readability, reply guide, claims |
| `tests/reply-guard.test.mjs` | **reply guard** state machine (debt, settlement, nudge ceiling) |
| `tests/onboarding.test.mjs` | **new-session onboarding** and the participation gate |

## Error codes

| code | meaning |
|---|---|
| `E_DISABLED` | this project is not enabled |
| `E_TARGET_NOT_FOUND` | no such target in this project |
| `E_AMBIGUOUS_TARGET` | the reference matched several identities |
| `E_BROADCAST_DISABLED` | `router.allowBroadcast=false` |
| `E_BROADCAST_EMPTY` | broadcast found no targets |
| `E_PAYLOAD_EMPTY` / `E_PAYLOAD_TOO_LARGE` | payload validation |
| `E_REPLY_TARGET_MISSING` | `dsh_bus_reply` without a resolvable `replyTo` |
| `E_TRANSPORT` | transport-level failure |

## Known limitations

**An inactive session cannot be reliably woken.** A session that is not currently loaded in the
host process (`status: "inactive"` in `dsh_bus_agents`) can be cold-started with
`agentLoop.resume`, and the message does reach its queue — but the host will not drive that resumed
agent through a turn on its own. The message is delivered when the session next becomes active.
For immediate wake-up the target must be `live` (opened in the UI at least once).

This is host behaviour, not something the plugin can work around. `deliveries[0].detail` says which
of the two happened.

**Hot reload cannot replace routes or modules.** DSH's ESM cache and the duplicate-exact-route guard
mean code changes need a host restart; the plugin itself supports hot re-mount for config changes.
