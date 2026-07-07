# Contributing to Beam

## Prerequisites

- Node >= 22
- npm >= 10

```bash
git clone https://github.com/beamtunnel/beam
cd beam && npm ci
```

## Daily workflow

```bash
npx vitest run          # full test suite (~1s)
npm run lint            # eslint (flat config, complexity <= 10)
npm run typecheck       # tsc --noEmit (strict mode)
npm run build           # compile to dist/
```

All four must exit 0 before a PR is opened.

## Architecture rules (non-negotiable)

Read [CLAUDE.md](CLAUDE.md) — it is the engineering constitution. Key constraints:

- **Layer boundaries**: Presentation → Application → Domain ← Infrastructure. A domain type must never import from infrastructure. A presentation file must never call infrastructure directly.
- **No global state**: every dependency is injected. The composition root (`src/composition.ts`) is the only place concretions are bound.
- **Complexity ceiling**: cyclomatic complexity ≤ 10 per function. ESLint enforces this.
- **Test coverage**: every new function in Application or Domain gets a unit test in the same task.

## Naming conventions

| Thing | Pattern |
|-------|---------|
| Repository methods | `fetch*()`, `find*()`, `persist*()`, `remove*()` |
| Use cases | `Execute*UseCase`, `Query*UseCase` |
| Entities | PascalCase nouns (`Session`, `Frame`) |
| Events | Past-tense past (`SessionEstablished`, `PeerConnected`) |
| Test files | `tests/<layer>/<module>.test.ts` (mirrors `src/` exactly) |

## Hard stops (require human approval)

- Adding a new runtime dependency
- Changing authentication or PIN logic
- Modifying `.githooks/**` or `eslint.config.js` complexity threshold
- Editing `CLAUDE.md` or the `CORE_FILES` list
- Any change to the signaling Durable Object wire protocol

## Running specific tests

```bash
npx vitest run tests/infrastructure/replay-client.test.ts
npx vitest run tests/domain/frame.test.ts
```

## PR checklist

- [ ] `npx vitest run` — all pass
- [ ] `npm run lint` — clean
- [ ] `npm run typecheck` — clean
- [ ] New functions in Application/Domain have corresponding tests
- [ ] No secrets or credentials in diff
- [ ] `LIMITATIONS.md` / `SECURITY.md` updated if behaviour changes

## Commit style

Conventional Commits: `type(scope): imperative description`

```
feat(relay): stream response body in chunks
fix(mdns): add multicast group membership for unicast-response fallback
test(replay): cover path traversal rejection
docs(security): document PIN brute-force resistance
```
