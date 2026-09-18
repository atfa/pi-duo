# pi-duo

A pure extension for Pi Coding Agent that keeps two peer agents in one project:

- **Austin** — the current foreground Pi session
- **Tony** — an independent background Pi SDK `AgentSession`

Both retain separate Pi conversation histories. They share only the workspace, goal, todo, decisions, and selected peer messages.

## Requirements

- Pi Coding Agent 0.85.1 or newer
- Two models already configured in Pi's normal provider/model configuration

No provider or model is hardcoded.

## Install

```bash
cd /path/to/pi-duo
npm install
mkdir -p ~/.pi/agent/extensions
ln -sfn "$PWD" ~/.pi/agent/extensions/pi-duo
```

Then run `/reload` in Pi (or restart Pi).

For this development checkout, the symlink can be installed directly because its dependencies are already available locally.

## Start

Austin uses the current Pi model. Select Tony interactively:

```text
/duo start
```

Or specify Tony explicitly:

```text
/duo start --peer provider/model
/duo start --peer provider/model --goal "Fix the parser race"
```

The selected models are saved to `<project>/.pi-duo/config.json`. You may instead create that file from [`config.example.json`](config.example.json): `agentA` specifies Austin and `agentB` specifies Tony. Because Austin is the already-running foreground session, select the configured `agentA` model in Pi before `/duo start`; a mismatch is rejected. If `agentA` is initially omitted, `/duo start` records the current model, and later Pi model selections keep it synchronized.

## Commands

```text
/duo                  # status
/duo status
/duo start [--peer provider/model] [--goal "..."]
/duo goal <new goal>
/duo stop             # preserve both histories
/duo resume           # reopen Austin's and Tony's saved Pi sessions
/duo config writePolicy=austin-only
/duo config autoDispatch=false maxPeerMessagesPerTurn=4
```

Agent tools:

- `duo_send` — send a selected message into the peer's real session context
- `duo_status`
- `duo_goal`
- `duo_todo`
- `duo_decisions`
- `duo_workspace` — manage write ownership

## Persistence

Project-local state is stored under `.pi-duo/`:

- `config.json` — model selection, write policy, and loop limits
- `state.json` — goal, todo, decisions, session metadata, status
- `messages.jsonl` — selected peer-message audit log
- `decisions.md` — readable durable decisions
- `sessions/` — Tony's native Pi JSONL session history

Austin's history remains in Pi's normal session directory. `/duo resume` switches back to that saved foreground session when necessary.

State changes use a revision, a cross-process lock directory, atomic file replacement, and stale-lock recovery. Conversation histories are not copied into shared state.

## Runtime behavior

With `autoDispatch: true`, each normal user task is also delivered to Tony. Austin and Tony can investigate concurrently and communicate only when useful; neither is assigned a fixed planner/reviewer role. Important Tony messages appear in the main UI as `[Tony]` entries.

Loop protection includes:

- maximum peer messages per user turn
- maximum consecutive peer-only messages without material tool activity
- similarity suppression against recent messages

When the per-turn total is exhausted, the first additional `important` or `decision` message is still written to the peer's persistent context and `messages.jsonl`, but it does not trigger another model turn. Further overflow and normal-priority overflow are rejected. This preserves one late critical finding without allowing an unbounded peer loop.

The default `writePolicy` is `austin-only`: Austin is the sole project-file writer, while Tony reads, investigates, tests, challenges assumptions, and sends consolidated file-and-line findings for Austin to implement. `duo_workspace` cannot release or transfer ownership in this mode, and stale project state is normalized back to Austin. Shared `.pi-duo` state and Tony's own session files remain writable because they are extension metadata, not project edits.

Set `writePolicy=transferable` to enable the advanced multi-writer workflow. In that mode, `edit`, `write`, and recognizable mutating shell commands are blocked for the non-owner, and agents transfer ownership with `duo_workspace`. Release and transfer are bidirectional control-plane events that dispatch a peer wake-up even when message budgets are exhausted. The tool returns the committed ownership snapshot without waiting for the peer's full turn.

The shell classifier is intentionally conservative and is not an OS sandbox: an arbitrary script or test command may still create project files. Use Git review and disposable branches for untrusted or high-risk tasks.

## Offline verification

These do not call a remote model API:

```bash
npm run check
npm test
```

To perform the smallest live check, start Pi in a disposable project, run `/duo start`, then `/duo status`. A normal prompt will call both configured models when `autoDispatch` is enabled.
