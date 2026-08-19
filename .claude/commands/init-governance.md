One-time governance bootstrap (run once, immediately after install.ps1) — interrogates you about your stack and architecture, then writes CLAUDE.md, layer scaffolding, and enforcement hooks. Source of truth: v1_implementation_package_existing.md.

Read the file `v1_claude_code_development_guide_existing.md` in this repository's root.
It is the engineering standard this initialization implements — internalize
Sections 2 (configuration), 4 (stateful layer + enforcement hooks), 5 (covenants),
6 (testing discipline), and SECTION 2.5 (cognitive routing + execution covenants)
before doing anything.

CRITICAL: SECTION 2.5 rules are NON-NEGOTIABLE and fire on EVERY task in this
governed repository, starting immediately after initialization:

SECTION 2.5 — COGNITIVE ROUTING & EXECUTION COVENANTS (Always Active)

  2.5.1 — MODEL INTERCEPT (Cognitive Routing)
    Every task triggers automated model selection logic BEFORE execution:
    - Analyze task type: (architecture | security | performance | test | deploy)
    - Route to appropriate model if available; fallback to primary if not
    - This routing is NON-BYPASSING — the agent cannot override it
    - Task routing decisions are logged in covenant_state.json ledger

  2.5.2 — EXECUTION MODE DECLARATION (Menu Covenant)
    Before ANY file is written, the agent MUST declare ONE of:
      [ ] MUST OUTPUT: task is design/analysis/report — no code changes, only text
      [ ] HARD STOP: task requires human approval before proceeding (new dep,
          auth change, schema change, CORE_FILES edit, settings change)
      [ ] EXECUTE: task is code change — proceed with full pipeline
    Wrong declaration blocks the task. The agent cannot change mode mid-task.

  2.5.3 — GRAPH MEMORY PROTOCOL (Tool Invocation Rules)
    Every tool call is context-aware and logged:
    - Read tools: logged once per file per session (avoid re-reads)
    - Bash commands: cached stdout for 5-minute reuse window
    - Edit/Write tools: require prior Read call (trust-root rule)
    - Web/External tools: only after exhausting local codebase tools
    - If tool call is repetitive (same call within 10 mins): STOP and analyze
    - Graph memory (what the agent knows about the codebase) expires at
      session boundary; new session = fresh recon

  2.5.4 — GITFLOW BRANCH ENFORCEMENT (Hard Block on Protected Branches)
    These rules are MECHANICAL, never conditional:
    - BLOCK HARD: any git push to main / master / develop (pre-push hook refuses)
    - BLOCK HARD: git commit on main / master / develop (feature branch mandate)
    - Feature branch naming: feature/*, fix/*, docs/*, chore/* only
    - Pre-push hook verifies branch protection BEFORE auth/network checks
    - User cannot override; no --force, no --no-verify, no exceptions
    - Protected-branch bypass requires human-authored PR + code review
    - Protected branch = main, master, develop, production, release/*

  2.5.5 — TOKEN HARNESS & COST AWARENESS (Hard Blocks at Budget Thresholds)
    Token budgets are PER-TASK, non-negotiable:
    - Task token budget: 200,000 tokens (default, specified in system prompt)
    - Soft warning at 70% (140,000 tokens): agent must summarize & checkpoint
    - Hard block at 100% (200,000 tokens): execution STOPS immediately
    - History retransmission waste (repeated passages) hard block at 50%
      - If retransmitted content exceeds 50% of budget, task halts
    - When hard block fires: state what is known, what remains unfinished,
      write all checkpoints, then exit (never continue on next token window)
    - Token budget resets per task; cannot carry over or negotiate up
    - Cost warnings MUST be emitted to user at 80%, 90%, 100%

  2.5.6 — EXECUTION PIPELINE INVARIANTS (Always Fire, Never Bypass)
    Every code-change task auto-triggers this pipeline without confirmation:
    Step 1: RECON (read-only) — grep, locate, scope the change
    Step 2: CONTRACT (internal) — SCOPE/OBJECTIVE/CONSTRAINTS/VERIFY/OUTPUT
    Step 3: EXECUTE — write code, run tests, verify covenants
    Step 4: OUTPUT — change manifest, test results, commit message
    
    Hard stops within pipeline: new dependency, auth change, schema change,
    CORE_FILES edit, settings change, permission-mode change, hook modification.
    Agent states the hard stop, waits for human approval, cannot self-resolve.

  2.5.7 — VS CODE / IDE EXTENSION CRASH GUARD (Non-Bypassing Environment Rule)
    Before outputting the Execution Mode Menu (2.5.2/2.5.3) or blocking execution
    on an interactive human choice, the agent MUST check whether it is running
    inside a non-TTY or IDE-extension terminal wrapper (e.g. `[ -t 0 ]` is false,
    or extension env flags such as TERM_PROGRAM=vscode, VSCODE_PID,
    VSCODE_GIT_IPC_HANDLE, CURSOR_*, or a JetBrains terminal marker are present).
    Sequential interactive dialog loops choke the extension's sub-process pipeline
    and crash the editor window. If an extension / non-interactive environment is
    detected:
      1. DO NOT launch an interactive choice loop or call AskUserQuestions
         sequentially.
      2. EXECUTION MODE MENU: automatically select option [1] DIRECT as the safe
         default, log the auto-selection to .claude/session_state.json
         (mode=DIRECT, reason=extension_crash_guard, timestamp), and output the
         high-visibility line:
         "[CRASH GUARD] VS Code/IDE extension detected. Suppressing interactive
          menu and defaulting to Option 1 (DIRECT) to prevent UI crash."
      3. HARD STOPS: do NOT stall on an un-answerable prompt loop. State the
         hard-stop parameters clearly in plain text, emit a clean one-line
         warning, write a checkpoint file under .claude/checkpoints/ capturing the
         pending decision, and halt execution awaiting the human's next message —
         never a blocking interactive read.
    This rule is environment-detection only; it never weakens a hard stop's
    requirement for human approval — it changes HOW approval is solicited (async
    text + checkpoint) so the editor cannot freeze. In a real TTY (CLI / desktop
    app) the normal interactive menu and prompts apply unchanged.

  2.5.8 — LONG-SESSION CONTEXT ANCHORING (Ground Truth Re-verification)
    To prevent attention degradation or context amnesia over extended execution
    timelines, treat `CLAUDE.md` on disk as your unalterable ground truth:
    - At the start of every distinct feature phase, task branch, or covenant
      invocation, perform a full re-read of `CLAUDE.md` to refresh your
      architectural alignment.
    - covenant.sh mechanically detects CLAUDE.md hash drift and warns when the
      constitution has changed since the last verified pass — heed that warning
      by re-reading the file before proceeding.
    - At the start of every session, if `.claude/checkpoints/LATEST.md` exists,
      read it and run `git rev-parse HEAD`. SHA matches checkpoint → execute
      RESUME INSTRUCTION and announce "Resuming from checkpoint <timestamp>:
      <task>". SHA diverged → state divergence and ask. Clearly new task →
      ignore; the old checkpoint will be superseded at next write.
    - After every successful `git commit`, immediately write LATEST.md using the
      full checkpoint schema. Not optional — this is the mechanism that makes
      /clear safe across sessions. A fresh session reads LATEST.md and continues
      without loss. Write LATEST.md before any push attempt.
    - Before executing any remote branch push command, compile and write a
      comprehensive state snapshot to `.claude/checkpoints/LATEST.md` capturing:
      what changed, why, and the architectural delta against baseline. covenant.sh
      enforces this at the pre-push boundary for agent sessions: it performs an
      immutable process-tree traversal from PPID to PID 1 to confirm the push
      originates from the Claude binary, then hard-blocks if no checkpoint exists.
      Human pushes are never blocked — process-tree tracking isolates agent and
      human tracks at the OS level with no heuristic bypass surface.
    - Monitor for context degradation signals: re-reading files already read this
      session (SD1), reproducing a fixed mistake (SD2), narrating prior steps
      unprompted (SD3), hedging on previously unambiguous facts (SD4), or 5+
      phases / 8+ files / session > 3 hours since last /clear (SD5). When 2+
      signals fire simultaneously: stop, write LATEST.md, output the forced
      handoff message ("CONTEXT SATURATION DETECTED..."), and wait for /clear
      before writing further code.
    - Your source of truth is the disk ledger, not the chat transcript.

  2.5.9 — DYNAMIC INTERROGATION & COMPULSORY BRAINSTORMING
    Scale architectural skepticism to classified task complexity:
    1. Tier 1 (Trivial/one-liner) or Tier 2 (simple single-file): proceed
       directly to execution without conversational overhead.
    2. Tier 3 (complex/multi-file) and above, or if you possess any
       contextual doubt regarding specifications, edge cases, or upstream
       contracts: you are STRICTLY FORBIDDEN from writing code until you
       execute a dedicated Brainstorming Phase.
    3. Brainstorming Phase Protocol:
       - Explicitly lay out your architectural hypothesis.
       - List the top 3 potential hidden regressions or failure modes.
       - Interrogate the human developer with specific, targeted questions
         to validate assumptions. Do not assume or guess missing
         specifications — demand clarity before a single line of code is
         written to disk.
    covenant.sh enforces this as a hard pre-commit block for agent sessions only:
    `_is_claude_agent_process()` traverses the OS process tree recursively;
    ≥5 staged files with no `.claude/checkpoints/LATEST.md` exits 1. Human
    commits are unaffected — the process-tree check provides a clean separation
    with no environment-flag or session-wrapper bypass surface. The graph index
    lifecycle uses a kill-and-restart loop (`_ensure_graph_freshness`): any
    active indexer is terminated via kill -9 before a fresh build for the
    current HEAD is spawned, preventing stale-index drift across commits.

You are initializing an EXISTING repository. The prime directive: the
constitution you generate DESCRIBES the architecture that actually exists.
Every rule you write will be enforced by mechanical covenants and SECTION 2.5
cognitive routing on every future task. A rule that contradicts reality
creates permanent noise.

PHASE A — STAGED RECONNAISSANCE (READ-ONLY. Write NOTHING in this phase.)

Execute in this exact order, cheapest first, and respect the budget caps:

  A1. STRUCTURE PASS (no file contents):
      - git ls-files | wc -l   (record total file count)
      - Directory tree to depth 3 with per-directory file counts
      - If total tracked files exceed 5,000: STOP after this pass, show me the
        top-level map, and ask which subsystem/package this constitution should
        govern. Re-scope all later passes to my answer.

  A2. MANIFEST PASS (manifests only, no source):
      - Read every dependency manifest present (requirements.txt,
        pyproject.toml, package.json, go.mod, Cargo.toml, pom.xml, etc.)
      - Read lockfile NAMES only (do not parse lockfile contents)
      - Read CI config filenames (.circleci/, .github/workflows/, etc.)
      - Identify: language(s) + versions, frameworks, test runner, linter,
        type checker, build tool — record the EXACT commands the repo uses
        (from CI config and manifest scripts, not from your assumptions).

  A3. SAMPLED SOURCE PASS (strictly budgeted):
      - From the A1 map, identify the apparent architectural layers (whatever
        they actually are — handlers/, services/, lib/, utils/, a flat src/).
      - Read 2–3 representative files PER layer, using offset+limit section
        reads where files exceed ~200 lines. HARD CAP: 15 files total.
      - From these, record: real naming conventions (function/class/file
        naming as it IS), how errors are handled, how config/env vars are
        accessed, how the DB or external services are called, how auth is
        enforced, how tests are structured and what they mock.

  A4. DEPENDENCY-GRAPH PASS (for CORE_FILES and test impact):
      - Build a coarse import graph (grep import statements; this graph is a
        LOWER BOUND — note where re-exports, dynamic imports, or DI/fixture
        injection exist, because grep cannot see through them).
      - Record every module imported by more than 5 other modules, plus
        config, base models, DI wiring, and test fixtures — this becomes the
        CORE_FILES list.
      - Identify available test-impact tooling for the stack (pytest-testmon,
        jest --changedSince, go test rdeps, bazel). If none is installed AND
        the suite exceeds ~200 tests, installation at init is MANDATORY
        (Guide §6 T3) — never deferred to "when the suite gets slow". It is
        a dependency hard stop: request my approval in the discovery report.

  A5. DEBT BASELINE PASS (identities, not just counts; fix NOTHING):
      - Run the repo's linter, type checker, and (if available for the
        stack) security scanner.
      - For EVERY finding record: file, rule id, line, and a finding
        fingerprint. FINGERPRINT ALGORITHM: hash the tuple
        (normalized_file_path, rule_id, floor(line/5)*5) — bucketed line
        for shift stability. Do NOT re-read source files to compute
        fingerprints; derive them from scanner output only. This keeps
        fingerprint computation O(1) per finding regardless of finding
        count and prevents context inflation on large finding sets.
      - For every debt category with NO available scanner, record the
        category as NO_SCANNER — absence must be loud, not silent.
      - Run the test suite in collection-only mode; record total test count,
        collection cleanliness, and (if cheap) full-suite wall time.
      - Detect layer violations against the A3 architecture; record them
        with the same identity schema.

PHASE B — DISCOVERY REPORT (show me, then STOP and wait)

Present a single report:

  1. STACK: languages, frameworks, exact test/lint/typecheck/build commands
  2. ARCHITECTURE AS FOUND: the real layers, their directories, the real
     dependency direction, where it deviates from clean layering (descriptive,
     no judgment)
  3. CONVENTIONS AS FOUND: naming patterns, error handling style, config
     access pattern, test structure and mocking pattern
  4. DEBT BASELINE: finding counts by category and severity, plus the count
     of distinct finding identities recorded; every NO_SCANNER category
     listed explicitly
  5. CORE_FILES: the proposed list from A4 with each entry's import count
  6. TEST-IMPACT TOOLING: what exists; if none, which tool you propose to
     install (this is a hard stop — I must approve it here)
  7. PROPOSED HARD-STOP LIST: the universal list from Guide §2.2.3 plus any
     repo-specific dangers you observed (e.g. a migrations/ directory, a
     deploy script)
  8. ANYTHING AMBIGUOUS: where you could not determine the convention and
     what you propose to assume

Then STOP. Do not write any file until I reply confirming or correcting the
report. Incorporate my corrections as ground truth — they override your
inferences wherever they conflict.

PHASE C — DEPLOYMENT (after my confirmation, write everything, no further
questions)

  CRITICAL EXECUTION ORDER: .claude/settings.json already exists — install.sh
  scaffolded it with the universal, repo-independent deny-list before this
  prompt ever ran (see §C2 below). That scaffold deliberately excludes
  Write/Edit denial on .claude/settings.json itself, CLAUDE.md, and
  .claude/baseline.json, because those three don't exist yet and you need to
  create them. Your LAST edit in Phase C — after CLAUDE.md, baseline.json,
  .githooks/ contents, and quarantine.txt are all fully written to disk —
  must ADD exactly these three self-lock pairs to the existing
  permissions.deny array: "Write(.claude/settings.json)",
  "Edit(.claude/settings.json)", "Write(CLAUDE.md)", "Edit(CLAUDE.md)",
  "Write(.claude/baseline.json)", "Edit(.claude/baseline.json)". Once that
  edit lands, these files are completely agent-immutable by design — this is
  the same "write-once lock" guarantee the original design had, just now
  scoped to three entries instead of the whole file. Re-running initialization
  or repairing these files is a human-only action (hand-edit + PR); the agent
  cannot self-repair.

  As part of this same final step, set `constitution_source_version` in
  `.claude/covenant_state.json` to this framework's version (read `install.sh`'s
  own `FRAMEWORK_SEMVER` constant, or the version noted in
  `v1_claude_code_development_guide_existing.md` if present). This is how a
  future `install.sh --upgrade` knows whether the dev guide's content has
  changed since CLAUDE.md was generated, and whether `/reconcile-governance`
  needs to run — leaving it null means an upgrade can never detect drift.

  C1. CLAUDE.md at the repository root — the DESCRIPTIVE constitution:
      - Architecture enforcement section using the CONFIRMED layer names and
        directories (never invented ones), with each layer's owns / must-not /
        calls rules derived from observed reality
      - Naming contracts AS DISCOVERED
      - The universal security invariants (Guide §2.2.2) verbatim
      - The ENFORCEMENT SCOPE rule verbatim from Guide §2.2.1 — constitution
        applies fully to new files and modified regions; untouched legacy is
        exempt until touched; flag debt, never block on it
      - Hard stops: the confirmed list from the report, INCLUDING
        permission-mode/settings changes, CORE_FILES edits, baseline changes
        without an audit receipt, and quarantining a core-covering test
      - The CORE_FILES glob list from the confirmed report
      - The boundary caveats P1–P3 from Guide §2.3 (permission mode pinned,
        git push always standalone — never in compound commands, refspec-force
        banned in text and refused by the pre-push hook)
      - Testing requirements referencing the 3-tier selection model (Guide §6)
        with the repo's EXACT test commands per tier, transitive-closure rule
        for CORE_FILES, and the grep-is-a-lower-bound escalation rule (T5)
      - A requirement (Guide §2.5.6a / §3.2.1) that PHASE 2's design
        declaration always includes an explicit GOAL/VERIFY pair and, where
        multiple interpretations exist, an ASSUMING/ALTERNATIVE declaration —
        a checkpoint or commit lacking a stated verification target does not
        satisfy the design-declaration requirement, even if tests happen to
        pass; and the Scope Discipline check (Guide §2.5.6a) runs before
        every checkpoint write, not after the diff is already staged
      - The Blocking Questions rule (Guide §2.5.6b): every HARD STOP and
        genuine scope fork is surfaced via a structured, blocking question
        mechanism (e.g. AskUserQuestion), never buried as a sentence inside
        a longer text response — a hard stop a human can scroll past isn't
        one
      - The auto-pipeline (recon → contract → execute → output) and the
        commit/push covenant including mandatory push confirmation, per Guide §5.3
      - Checkpoint trigger rules C1–C5 and the resume protocol, per Guide §4.1
      - A governance note (Guide §2.2.4): CLAUDE.md, the CORE_FILES list,
        settings, hooks, and baseline change ONLY via human-authored PR, never
        via agent edit; the agent never self-maintains the constitution

  C2. .claude/settings.json — MERGE, do not regenerate. install.sh already
      scaffolded this file at install time via `_write_trust_root_settings`
      (universal, repo-independent deny-list + a Bash-matcher PreToolUse hook
      at `.claude/hooks/pre_bash_trust_root_guard.sh` that inspects the actual
      Bash command text for trust-root paths — closes the gap a static
      prefix-matched deny-list cannot: it can express "starts with X," never
      "mentions path Y anywhere," so redirection/tee/sed -i/python writes to a
      protected file aren't catchable by deny-list strings alone). Verify this
      scaffold is present (`.claude/settings.json` exists, its
      `permissions.deny` array is non-empty, `hooks.PreToolUse` contains the
      Bash-matcher entry) before adding anything — if missing, install.sh was
      an older version; re-run it before continuing rather than hand-authoring
      the deny-list from scratch. Your only job here is to ADD:
      - "defaultMode": "default" (already present from the scaffold — do not
        remove it)
      - Allow list: the exact read-only commands, plus this repo's confirmed
        test runner, linter, type checker, and build commands; git add/commit/
        diff/status/log/update-index
      - The reference deny-list below is what install.sh already wrote —
        listed here so you can verify it's intact, not so you re-type it:
        git reset --hard, git rebase, git clean, rm -rf, sudo,
        raw DDL (DROP/TRUNCATE/DELETE FROM), nc/ssh/scp,
        ALL force-push variants ("git push --force", "git push -f",
        "git push --force-with-lease", "git push --mirror",
        "git push --delete"),
        HOOK-EVASION variants ("git commit --no-verify*", "git commit -n *",
        "git push --no-verify*", "git -c core.hooksPath*") — without these,
        the allow-listed git commit is a silent back door around the entire
        enforcement layer,
        "Bash(SKIP_COVENANT=*)" (the agent must never be able to form the
        bypass; verify the matcher catches env-prefixed commands — if it
        does not, the pre-commit hook must refuse SKIP_COVENANT when
        agent-environment markers like $CLAUDECODE are present),
        and credential reads: "Read(.env)", "Read(**/.env)",
        "Read(**/.env.*)", "Read(**/*.pem)", "Read(**/id_rsa*)",
        "Read(**/.aws/credentials)", plus the equivalent Bash cat patterns,
        and TRUST-ROOT writes for the files install.sh itself owns (never
        agent-generated, so safe to lock from install time): "Write(.githooks/**)",
        "Edit(.githooks/**)", "Write(.claude/hooks/**)", "Edit(.claude/hooks/**)"
        (Module A10 — this is the Bash-guard hook's OWN script; without this
        an agent can overwrite it with a one-line no-op while its
        `hooks.PreToolUse` registration stays intact in settings.json, making
        the guard LOOK active while doing nothing — a stealthier bypass than
        any of the ones the guard itself closes),
        "Write(.claude/covenant_integrity.sha256)", "Edit(.claude/covenant_integrity.sha256)"
        — without this, an agent that weakens .githooks/covenant.sh can simply
        regenerate the pinned hash to match in the same turn, and the CI
        content-check added in Module A6 verifies nothing; only a
        human-authored PR may move this pin,
        "Write(.claude/covenant_state.json)", "Edit(.claude/covenant_state.json)"
        (Module A10 — this is the covenant's own ledger: receipts, token spend,
        the audit log. An agent that can Write/Edit it directly can fabricate
        a passing receipt or reset its own token budget, defeating every
        other control in this chain. covenant.sh's own legitimate mutations run
        via a git-hook subprocess calling python3 directly — never through
        Claude Code's Write/Edit tools — so this denial has zero effect on
        covenant.sh's normal operation, only on the agent's own tool calls),
        "Write(.mcp.json)", "Edit(.mcp.json)" (Module A10 — controls which
        MCP servers Claude Code connects to; install.sh-owned, static after
        install, never agent-edited),
        "Write(.github/workflows/covenant.yml)", "Edit(.github/workflows/covenant.yml)"
        (Module A9 — the CI workflow file that INVOKES the whole integrity
        chain was itself unprotected through three rounds of hardening;
        without this, an agent can gut the "Run governance covenant" step or the
        `on:` triggers directly, with none of the hash-pin or Bash-guard
        machinery ever coming into play — a simpler, undefended bypass than
        any of the ones those mechanisms close),
        "Write(v1_claude_code_development_guide_existing.md)",
        "Edit(v1_claude_code_development_guide_existing.md)",
        "Write(v1_implementation_package_existing.md)",
        "Edit(v1_implementation_package_existing.md)",
        "Bash(git notes*remove*)", "Bash(git update-ref -d*)",
        and PERSISTENT-HOOK-DISABLE + UNTRACKED-COMMIT variants:
        "Bash(git config core.hooksPath*)",
        "Bash(git config --add core.hooksPath*)", "Bash(git commit -a*)",
        "Bash(git commit -am*)", "Bash(git commit --amend*)" — the persistent
        git config form disables hooks for the whole clone, and -a/-am/--amend
        break the index-equals-commit-tree guarantee the covenant relies on
      - NOT in this install-time scaffold, by design: "Write(.claude/settings.json)",
        "Edit(.claude/settings.json)", "Write(CLAUDE.md)", "Edit(CLAUDE.md)",
        "Write(.claude/baseline.json)", "Edit(.claude/baseline.json)" — these
        three files don't exist yet at install time and you need to create
        them. Add these six entries as your LAST edit in Phase C, per the
        CRITICAL EXECUTION ORDER note above — never before CLAUDE.md,
        baseline.json, and settings.json's own allow-list are fully written
      - The Bash-matcher guard hook (`.claude/hooks/pre_bash_trust_root_guard.sh`)
        deliberately protects .githooks/, .claude/hooks/ (itself),
        covenant_integrity.sha256, .claude/covenant_state.json,
        .github/workflows/covenant.yml, .mcp.json, and the dev-guide/init-package
        filenames — NOT CLAUDE.md/settings.json/baseline.json, since you
        legitimately need to reference those via Bash/python during this very
        phase (reading current state, merging JSON). Do not add them to that
        hook's protected-paths array.
      - The trust-root deny-list has exactly ONE source of truth: a single
        `REQUIRED_DENY` Python list inside `_write_trust_root_settings` in
        install.sh, shared by both the fresh-install and the idempotent-merge
        code paths (`os.path.exists` selects which branch runs). There is no
        second hand-authored copy anywhere to fall out of sync — do not
        introduce one; if you need to check what install.sh already wrote,
        read `.claude/settings.json` directly.
      - `.claude/covenant_integrity.sha256` is a multi-file manifest (native
        `sha256sum`/`shasum -a 256` check format — one `<hash>  <path>` line
        per file), not a single hash. It covers every static,
        install.sh-owned governance script: `.githooks/covenant.sh`,
        `.githooks/verify_governance_integrity.sh`, `.githooks/pre-commit`,
        `.githooks/pre-push`, and `.claude/hooks/pre_bash_trust_root_guard.sh`.
        `verify_governance_integrity.sh` checks all five with one
        `sha256sum -c` / `shasum -a 256 -c` call. Do not narrow this back to
        checking only covenant.sh — the whole point is that weakening any one of
        the five scripts in the enforcement chain is caught the same way.
      - git push appears in NEITHER list (Guide §2.3 — it must prompt
        interactively, not be silently allowed or hard-blocked)

  C3. .claude/baseline.json — the frozen debt baseline (Guide §4.3.2 schema):
      - Per-finding identity records from A5: file -> [{rule, line_hint, fp}]
      - Summary counts, scanners map (including every NO_SCANNER entry),
        generated_at, generated_from_sha
      - This file WILL be committed — it is shared team state

  C4. .claude/commands/ — four command files, with this repo's REAL commands
      substituted into every verification block:
      - feature.md: Phases 0–5 per Guide §3.2 including stubs-first (Phase 2.5,
        mandatory at 3+ files), the three-strike rule, the corrected index
        protocol before every re-run (git update-index -q --refresh; git diff
        --no-ext-diff — refresh reconciles stat metadata ONLY and must be
        paired with a content-level check), TIER 1 tests after each file,
        TIER 2 at the end, and checkpoint evaluation/writes at the phase
        boundaries defined in Guide §4.1.3, and COST-WARNING FIRING per
        Guide §7.1.1 (alert when a task iteration or phase exceeds ~40,000
        context tokens or history-retransmission waste crosses 50%).
        PHASE 2 (Design Declaration): the agent must programmatically deduce
        the testing architecture from repository roots (§6.0 Dynamic Stack
        Inference) — inspect package.json, requirements.txt, pyproject.toml,
        go.mod, or CI config; never assume a fixed runner. If a frontend or
        proxy layer is present, declare Playwright E2E user journeys implicitly
        (web-first async assertions, network contract checks) — zero prompts
        seeking human instruction on test paths.
        PHASE 3 (Implementation): execute all inferred test suites completely
        autonomously using the deduced runner engine(s). When UI/routing/rendering
        paths change, auto-generate and run Playwright specs (*.spec.ts or stack
        equivalent). Sequence backend + E2E runners; both must exit 0. No
        conversational filler or prompts asking the developer for test
        specifications are permitted.
      - audit.md: diff-scoped via the covenant script's change set (files changed
        since last_pass_sha + staged + unstaged + untracked; full-repo only on
        explicit request). For file-level scanners apply the HUNK-INTERSECTION
        rule (Guide §4.3.3a): scan the full file, intersect findings against
        git diff -U0 hunk ranges; in-hunk findings are identity-checked
        against baseline (new fp blocks, grandfathered passes); out-of-hunk
        baseline findings are summarized in one line, never as noise.
        Ratchet-down (R2): remove disappeared fingerprints from baseline.json
        and record them in the audit receipt — /review validates every
        baseline decrease against that receipt.
        Finding fps are whitespace/format-insensitive (canonical token
        stream before hashing); a simultaneous all-fp shift in a touched
        file with rule+file+count unchanged is a re-fingerprint event —
        re-anchor, do not block (Guide §4.3.2).
        SEVERITY NORMALIZATION TABLE: generate a mapping from each
        confirmed scanner's NATIVE levels (error/warning, E/W codes,
        HIGH/MEDIUM/LOW) AND test-runner output formats (JUnit XML, JSON
        reporters, Playwright HTML/matrix/JSON reporters, Go test -json,
        pytest exit codes) to the covenant actions {block-await-human,
        auto-remediate, record-only} and embed it in audit.md. Without
        it, "CRITICAL/HIGH blocks" is undefined for linters that only
        emit error/warning, for test suites that emit structured reports
        without severity labels, and the agent guesses.
        SELF-HEALING FAILURE BRANCH: if an auto-remediation attempt
        (MEDIUM/LOW) does not eliminate the finding on re-verify, treat
        it as a hard block and report to the human — do not attempt a
        second auto-fix. An auto-fix that fails once is a signal the
        finding requires human judgement, not a retry loop.
        Apply the §3.3 three-strike rule to any auto-fix attempt: three
        failed fix-and-re-verify cycles on the same finding → STOP,
        report verbatim, await human.
      - review.md: ledger-aware pre-PR covenant — recompute the FULL fingerprint
        (Guide §4.2.3, including untracked files) and compare against
        covenant_state.json; SKIP loudly only on exact match, printing the
        script-generated COVENANT REPORT verbatim (never a model-composed one).
        Otherwise: diff inventory, lockfile assertion (any lockfile diff
        without approved dependency = HARD STOP), per-changed-file layer
        compliance, secrets-in-diff grep, TIER 2 test execution (transitive
        closure for CORE_FILES), quarantine report (count + covered modules;
        a quarantined test covering CORE_FILES = HARD STOP), baseline-delta
        validation against audit receipts, conventional-commit verification,
        PR body generation; finish by having the covenant script write the new
        receipt atomically.
      - prep.md: converts a natural-language task into a SCOPE / OBJECTIVE /
        CONSTRAINTS / VERIFY / OUTPUT execution contract, zero implementation,
        hard stops flagged at the top.

  C5. THE ENFORCEMENT LAYER:
      Do NOT generate or modify `.githooks/covenant.sh`, `.githooks/pre-commit`, or `.githooks/pre-push`. These files have already been placed in the repository by the installation script. Leave them untouched. You must only verify that the `.githooks/` directory exists.

  C6. Stateful-layer bootstrap:
      - .claude/covenant_state.json with empty receipts and last_pass_sha: null
        (written only by covenant.sh from here on)
      - .claude/checkpoints/ with a README.md stating the schema from
        Guide §4.1.4 and the 10-file retention rule
      - quarantine.txt (empty, committed) with a header comment explaining
        Guide §6 T4

  C7. .gitignore additions (append, do not rewrite):
      .claude/covenant_state.json
      .claude/checkpoints/

  C8. .team_aliases at the repository root: Read
      v1_claude_code_development_guide_existing.md from disk and copy
      APPENDIX B (the section headed "APPENDIX B — CANONICAL .team_aliases")
      VERBATIM into .team_aliases, substituting only the <source-dirs>
      placeholder with this repo's confirmed source and test directories
      (from the discovery report). If a placeholder has no confirmed value,
      ask — never guess. Beyond that substitution the file is byte-identical
      to Appendix B. Do not invent, add, or omit functions — security-relevant
      shell is never generated from memory.

PHASE D — VERIFICATION AND MANIFEST

  D1. Re-run the test suite in collection mode — confirm the init broke
      nothing (it wrote no source code; this is a sanity check).
  D2. Make a no-op commit on the setup branch to prove the pre-commit hook
      fires and emits a COVENANT REPORT; then verify the pre-push hook refuses
      a dry-run push to a protected branch name.
  D3. Output a manifest table: File | Purpose | Key rules encoded.
  D4. Output the three-line summary I can paste to my team lead:
      what was installed, what the baseline counts are, what changes about
      daily workflow (answer: type intent; hooks and tiers handle the rest).
  D5. Remind me: commit CLAUDE.md, .claude/settings.json, baseline.json,
      commands/, .githooks/, quarantine.txt, .team_aliases, .gitignore —
      and that covenant_state.json and checkpoints/ stay untracked.
