Convert a natural-language task into an execution contract. `$ARGUMENTS` is
the task description. Zero implementation — this command only produces the
contract below.

Reference: `CLAUDE.md`, `v1_claude_code_development_guide_existing.md` §2.2.3
(hard stops), §3.2.1 (assumption declaration).

## Output format

```
SCOPE:
  <files/modules this touches, by layer — src/domain, src/application,
   src/infrastructure, src/presentation, signaling/src, viewer/src>

OBJECTIVE:
  <one or two sentences — the concrete, observable outcome>

CONSTRAINTS:
  <layer rules from CLAUDE.md that apply — e.g. "domain stays pure, no
   Date.now()", "no new process.env reads outside config.ts", "Result<T,E>
   for all fallible calls">

HARD STOPS FLAGGED (if any — list at the TOP, not buried):
  <any of: new dependency / lockfile change, schema or DO-storage-key
   change, auth/authz change (PIN pairing, path-authorization, rate
   limiting), new env var, wrangler.jsonc change, deploy script change,
   CI workflow change, .gitignore change, CORE_FILES edit,
   baseline.json edit, settings.json edit, .githooks edit — cross-check
   against CLAUDE.md's Hard Stops table>

VERIFY:
  <the specific test/command that would confirm this is done — not
   "tests pass" generically>

OUTPUT:
  <what /feature would produce: which files, which commit(s)>
```

If a hard stop is flagged, stop after producing the contract and surface it
via `AskUserQuestion` (per CLAUDE.md's Blocking Questions section) rather
than proceeding — `/prep` never implements, but a flagged hard stop still
needs an explicit human decision before anyone runs `/feature` on this
contract.
