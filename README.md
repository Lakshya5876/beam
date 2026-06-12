# Beam (project name placeholder)

Beam relays HTTP requests from a remote browser peer to a localhost server
over peer-to-peer data channels.

**The constitution for ALL work in this repository is [CLAUDE.md](CLAUDE.md).**
It is prescriptive, enforced mechanically from commit #1, and changes only
via human-authored PR. The engineering standard it implements is
[v1_claude_code_development_guide_new.md](v1_claude_code_development_guide_new.md).

## Quickstart

```bash
git clone <repo> && cd beam
npm ci                                    # exact-pinned toolchain
source .team_aliases && cc-init-hooks     # REQUIRED: activates .githooks +
                                          # bypass-note refspecs per clone
npx vitest run && npx eslint . && npx tsc --noEmit   # all exit 0
```

Daily workflow: type intent (`cc-feature "<task>"`); the hooks and the
pipeline handle the rest. Pushes are human-only from a plain shell
(`cc-push`), never from the agent — see CLAUDE.md §3 LOCAL-ONLY EXECUTION.

## Layout

```
src/domain/           pure business logic — zero dependencies
src/application/      use-case orchestration
src/infrastructure/   all I/O (signaling, peer connection, replay, log store)
src/presentation/     CLI + diagnostics surfaces
src/config.ts         single source of truth for env access (CORE_FILES)
src/composition.ts    DI wiring / composition root (CORE_FILES)
tests/                mirrors src/ exactly — tests/<layer>/<module>.test.ts
.githooks/            the mechanical gate (pre-commit / pre-push / gate.sh)
.claude/              constitution machinery (settings, commands, ledger)
quarantine.txt        committed flaky-test quarantine
```
