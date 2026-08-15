#!/usr/bin/env python3
"""CovenantWin deterministic governance engine + installer.

The engine intentionally uses structured subprocess arguments and pathlib so it
works on drive-letter, UNC, nested, and space-containing repository paths.

This is the Windows counterpart to CovenantMac's install.sh + templates/covenant.sh,
built to reach behavioral parity rather than sharing bash source directly
(bash-side changes can't be verified in every environment this engine ships
to). Where content has zero OS-specific meaning — the v1_release/ constitution
markdown, the pre-commit/pre-push bypass-audit-trail logic, the trust-root
Bash-guard script — this engine reuses the exact same files CovenantMac ships,
since Git for Windows bundles the `sh`/`bash` those depend on. See
docs/MIGRATION.md.
"""
from __future__ import annotations

import argparse, datetime as dt, difflib, fnmatch, hashlib, json, os, re, shutil, subprocess, sys
from pathlib import Path

STATE_REL = Path('.claude/covenant_state.json')
BASELINE_REL = Path('.claude/baseline.json')
# No separate PowerShell launcher script here — pre-commit/pre-push invoke this engine directly (see
# _write_hook_shim), removing the sh -> PowerShell -> Python hop the original
# CovenantWin hook chain used. pre_bash_trust_root_guard.sh (not .ps1) is the real,
# shared guard — see install()'s comment on why the .sh version is used as-is.
GOVERNANCE = ('.githooks/covenantwin.py', '.githooks/pre-commit', '.githooks/pre-push',
              '.claude/hooks/pre_bash_trust_root_guard.sh')

# High-confidence keyword+format matcher, not an entropy scanner — same
# documented scope as CovenantMac's covenant.sh (docs/SECURITY_POSTURE.md). Uses
# specific, well-known credential PREFIXES (sk_live_, ghp_, AKIA, PEM headers)
# rather than covenant.sh's bare "token"/"secret"/"password" keywords: those bare
# keywords, tried directly against the real shared v1_release/ dev-guide
# content during this port, false-positived on ordinary engineering prose
# ("Token Budget", "session token accounting") throughout the document — a
# real, previously-undiscovered gap in covenant.sh's own regex that a synthetic
# test fixture would never surface. Flagged as a finding for covenant.sh itself;
# not fixed there in this pass (no bats environment available to verify a
# bash-side regex change safely). CovenantWin intentionally does not inherit that
# specific false-positive-prone shape.
SECRET = re.compile(r'(api[_-]?key\s*[=:]|' + 'aws' + r'_access' + r'_key' + r'_id|BEGIN (?:RSA |EC )?PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{20,}|pk_live_[A-Za-z0-9]{20,})', re.I)
_SECRET_EXCLUDE = re.compile(r'placeholder|example|REDACTED')
SQL = re.compile(r'\b(SELECT|INSERT|UPDATE|DELETE)\b|cursor\.execute|psycopg2\.connect|JdbcTemplate|prepareStatement', re.I)
HTTP = re.compile(r'^(?:from|import)\s+(?:fastapi|flask|django\.http)|APIRouter|@(?:app\.|RestController|Controller|RequestMapping|GetMapping|PostMapping)', re.M)
DOMAIN_FW = re.compile(r'^(?:from|import)\s+(?:sqlalchemy|django\.|peewee|tortoise|sqlmodel|pymongo|psycopg2|redis|boto3|requests|httpx|fastapi|flask|celery)|@(Entity|Table|RestController|Repository)\b|from\s+[\'\"](?:typeorm|@prisma/client|sequelize|mongoose|express|fastify)', re.M)
# Matches a linter finding line shaped like "<path>:<line>[:<col>]: <RULE_CODE> ..."
# (ruff, flake8, eslint --format unix, etc. all produce this shape). Deliberately
# loose/stack-agnostic, mirroring covenant.sh's own identity-parsing regex.
LINT_FINDING = re.compile(r'^([^:]+):\d+(?::\d+)?:\s*([A-Z]+[0-9]+)')

# Same file-path classification covenant.sh uses to decide HAS_BACKEND/HAS_FRONTEND
# (covenant.sh:636-640) — used here for the fail-closed missing-test-runner check.
_SOURCE_PAT = re.compile(r'^(backend/|src/|app/|frontend/)|\.(py|java|go|rs|ts|tsx|jsx|rb|c|cpp|h|cs|swift|kt)$')

def _looks_like_source(rel: str) -> bool:
    return bool(_SOURCE_PAT.search(rel.replace('\\', '/')))

def _is_claude_agent() -> bool:
    # Primary signal only: $CLAUDECODE, set by Claude Code and inherited across
    # backgrounding/detachment (unlike process ancestry) — mirrors the first,
    # primary check in covenant.sh's _is_claude_agent_process (covenant.sh:299-302).
    # The process-tree-walk fallback covenant.sh also has is deliberately not
    # ported: Windows process ancestry needs either psutil (not stdlib) or
    # WMI/ctypes, and the env marker alone already covers the realistic case
    # (a live Claude Code session invoking git) these agent-only gates exist
    # for. Same disclosed, non-closable limit as covenant.sh: an agent that
    # strips its own environment (`env -u CLAUDECODE`) defeats this — not a
    # new gap introduced here.
    return bool(os.environ.get('CLAUDECODE'))

# Trust-root deny-list — same content as install.sh's REQUIRED_DENY
# (install.sh:198-223). Kept as one list here so CovenantMac and CovenantWin protect
# the identical set of dangerous commands/paths; update both together if this
# ever needs to change (there is currently no single shared Python module both
# installers import — see the "one engine" note in the module docstring for
# why that's a deliberate near-term gap, not an oversight).
REQUIRED_DENY = [
    "Bash(git reset --hard*)", "Bash(git rebase*)", "Bash(git clean*)",
    "Bash(rm -rf*)", "Bash(sudo*)", "Bash(DROP *)", "Bash(TRUNCATE *)",
    "Bash(DELETE FROM *)", "Bash(nc *)", "Bash(ssh *)", "Bash(scp *)",
    "Bash(git push --force*)", "Bash(git push -f*)",
    "Bash(git push --force-with-lease*)", "Bash(git push --mirror*)",
    "Bash(git push --delete*)", "Bash(git commit --no-verify*)",
    "Bash(git commit -n *)", "Bash(git push --no-verify*)",
    "Bash(git -c core.hooksPath*)", "Bash(SKIP_COVENANT=*)",
    "Read(.env)", "Read(**/.env)", "Read(**/.env.*)", "Read(**/*.pem)",
    "Read(**/id_rsa*)", "Read(**/.aws/credentials)",
    "Bash(cat .env*)", "Bash(cat **/.env*)", "Bash(cat **/*.pem*)",
    "Bash(cat **/id_rsa*)", "Bash(cat **/.aws/credentials*)",
    "Write(.githooks/**)", "Edit(.githooks/**)",
    "Write(.claude/hooks/**)", "Edit(.claude/hooks/**)",
    "Write(.claude/covenant_integrity.sha256)", "Edit(.claude/covenant_integrity.sha256)",
    "Write(.claude/covenant_state.json)", "Edit(.claude/covenant_state.json)",
    "Write(.claude/baseline.json)", "Edit(.claude/baseline.json)",
    "Write(.github/workflows/covenant.yml)", "Edit(.github/workflows/covenant.yml)",
    "Bash(git notes*remove*)", "Bash(git update-ref -d*)",
    "Bash(git config core.hooksPath*)", "Bash(git config --add core.hooksPath*)",
    "Bash(git commit -a*)", "Bash(git commit -am*)", "Bash(git commit --amend*)",
]
# Deliberately excludes Write/Edit(.claude/settings.json) and Write/Edit(CLAUDE.md):
# neither exists yet at install time and /init-governance must be able to
# create them, mirroring install.sh's identical exclusion (install.sh:224-236).

def run(args, cwd: Path, timeout=60):
    # encoding='utf-8' is required, not cosmetic: without it, subprocess.run's
    # text mode decodes with the OS default codepage (cp1252 on Windows),
    # which crashes on any UTF-8 byte a child process emits (e.g. an em-dash
    # in a commit/file it prints) — a real crash found via this engine's own
    # test suite once real UTF-8-bearing content (the shared v1_release/ docs)
    # started flowing through git subprocess calls. errors='replace' keeps
    # this fail-safe (never crash trying to report an error) rather than
    # fail-open (never silently swallow one).
    try:
        return subprocess.run(args, cwd=cwd, text=True, encoding='utf-8', errors='replace', capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return subprocess.CompletedProcess(args, 124, '', str(e))

def repo_root() -> Path:
    p = run(['git', 'rev-parse', '--show-toplevel'], Path.cwd())
    if p.returncode: raise RuntimeError('CovenantWin must run inside a Git working tree.')
    return Path(p.stdout.strip())

def load(path: Path, default):
    try: return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError): return default

def atomic_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(obj, indent=2) + '\n', encoding='utf-8')
    os.replace(tmp, path)

def state_default():
    return {'framework_version':'1.0.0-win','last_pass_sha':{},'last_pass_timestamp':None,
      'thresholds':{'coverage_pct':80,'complexity_max':10,'command_timeout_sec':30},
      'core_files':[],'receipts':{},'token':{'token_budget':None,'token_spent_today':0,'token_last_reset':None,'token_audit_log':[]},
      'commands':{'lint':None,'type':None,'test':None,'coverage':None,'complexity':None,'frontend_lint':None,'frontend_type':None}}

def changed_files(root: Path, state, trigger: str = 'pre-commit'):
    branch = run(['git','branch','--show-current'],root).stdout.strip()
    # CI mode: diff against the PR base / push's previous HEAD, resolved by
    # the installed workflow into CI_BASE_SHA. Mirrors covenant.sh's CI_BASE_SHA
    # handling (covenant.sh:576-613) and exists for the exact same reason: a CI
    # checkout has nothing staged, so `git diff --cached` below is
    # unconditionally empty regardless of what the PR/push actually changed.
    ci_base_sha = os.environ.get('CI_BASE_SHA', '').strip()
    if trigger == 'ci' and ci_base_sha and run(['git','cat-file','-e', ci_base_sha+'^{commit}'],root).returncode == 0:
        out = run(['git','diff','--name-only', f'{ci_base_sha}..HEAD'], root).stdout
        return branch, 'ci-diff', [x for x in out.splitlines() if x]
    head = run(['git','rev-parse','HEAD'],root)
    previous = state.get('last_pass_sha',{}).get(branch)
    no_usable_base = head.returncode or not previous or run(['git','cat-file','-e', previous+'^{commit}'],root).returncode
    if no_usable_base:
        if trigger in ('ci', 'pre-push'):
            # No resolvable base (new branch's first push/PR, or a wiped
            # ledger) at pre-push/CI: fail SAFE by scanning every tracked
            # file, never fail-open by silently scanning nothing — the same
            # cold-start gap covenant.sh itself was found and fixed for
            # (covenant.sh:591-607). `--cached` would be empty here regardless.
            out = run(['git','ls-files'],root).stdout
            return branch, 'cold', [x for x in out.splitlines() if x]
        out=run(['git','diff','--cached','--name-only'],root).stdout; mode='cold'
    else:
        out=run(['git','diff','--cached','--name-only', previous],root).stdout; mode='incremental'
    return branch, mode, [x for x in out.splitlines() if x]

def fail(message):
    print('COVENANT BLOCK: '+message, file=sys.stderr); return 1

def safe_command(command, root: Path, label: str, timeout: int, capture: bool = False):
    # User-configured commands preserve Covenant semantics; shell is used only for
    # explicit trusted repository configuration, never for file/path inputs.
    if not command: return (0, '') if capture else 0
    if capture:
        p = subprocess.run(command, cwd=root, shell=True, text=True, encoding='utf-8', errors='replace', capture_output=True, timeout=timeout)
        return p.returncode, (p.stdout or '') + (p.stderr or '')
    p = subprocess.run(command, cwd=root, shell=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
    if p.returncode: return fail(f'{label} failed (exit {p.returncode}).')
    return 0

def check_integrity(root):
    manifest=root/'.claude/covenant_integrity.sha256'
    if not manifest.exists(): return fail('governance integrity manifest is missing.')
    for line in manifest.read_text(encoding='utf-8').splitlines():
        expected, rel = line.split('  ', 1); p=root/rel
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=expected:
            return fail(f'governance integrity mismatch: {rel}')
    return 0

def _lint_identities(output: str) -> set[str]:
    # Identity = "<normalized_path>|<rule_code>" — line number excluded, so
    # reformatting/reflow doesn't re-trigger the ratchet. Mirrors covenant.sh's
    # identity model exactly (covenant.sh:1046-1061).
    ids = set()
    for line in output.splitlines():
        m = LINT_FINDING.match(line.strip())
        if m:
            ids.add(m.group(1).replace('\\', '/') + '|' + m.group(2))
    return ids

def _lint_with_ratchet(root: Path, state, timeout: int):
    # Usage: returns 0 to continue, 1 (already fail()-printed) to block.
    lint_cmd = state['commands'].get('lint')
    if not lint_cmd: return 0
    baseline = load(root/BASELINE_REL, None)
    ratchet_active = bool(baseline and baseline.get('populated') and isinstance(baseline.get('lint_findings'), list))
    if not ratchet_active:
        return safe_command(lint_cmd, root, 'lint', timeout)
    rc, output = safe_command(lint_cmd, root, 'lint', timeout, capture=True)
    found = _lint_identities(output)
    if not found and rc:
        # Unparseable linter output format -> fall back to exit-code enforcement,
        # same fallback covenant.sh uses (covenant.sh:1062-1068).
        return fail('lint failed (ratchet unavailable for this linter format).')
    known = set(baseline.get('lint_findings', []))
    new = found - known
    if new:
        return fail('new lint findings not in baseline (debt ratchet): ' + '; '.join(sorted(new)[:10]))
    return 0

def covenant(trigger: str):
    root=repo_root(); sp=root/STATE_REL; state=load(sp,state_default()); branch,mode,files=changed_files(root,state,trigger)
    # Skip in CI: actions/checkout@v4 checks out a real local branch (not
    # detached HEAD) for a push event, so `git branch --show-current` DOES
    # return e.g. "main" there — the comment this replaced assumed detached
    # HEAD and was wrong, confirmed by directly running the real
    # covenant.yml-equivalent trigger against a real checkout, not inferred.
    # Without this exemption every single push-triggered CI run against a
    # protected branch (main/master/develop — this workflow's own trigger
    # list) self-blocked here before any real check (secrets, layer
    # boundary, lint, tests) ever ran, including for a completely legitimate,
    # already-reviewed PR merge. The direct-push case itself is independently
    # blocked at the git level by the shared pre-push hook script's own
    # protected-branch guard, which runs before this engine regardless of
    # trigger — this CI-mode exemption doesn't reopen that path. Mirrors the
    # identical fix in covenant.sh (covenant.sh's STEP 1), found and fixed
    # there first via the same direct-execution method.
    if trigger != 'ci' and branch in {'main','master','develop'}: return fail(f"direct commits to '{branch}' are forbidden.")
    if trigger in ('pre-push', 'ci') and check_integrity(root): return 1
    # 1. Branch and token policy.
    token=state['token']; today=str(dt.date.today())
    if token.get('token_last_reset') != today: token.update(token_spent_today=0, token_last_reset=today)
    budget=token.get('token_budget')
    spend=root/'.claude/session_spend.tmp'
    active=int(spend.read_text().strip() or 0) if spend.exists() and spend.read_text().strip().isdigit() else 0
    if budget is not None and active and token['token_spent_today']+active >= budget: return fail('active agent token budget exhausted.')
    # 2. Scan scope and tier-3 escalation.
    print(f'COVENANT: scope={mode} | files={len(files)}', file=sys.stderr)
    tier3=any(any(fnmatch.fnmatch(f, pat) for pat in state.get('core_files',[])) for f in files)
    # 2.5. TIER-3 brainstorming block (pre-commit, agent-only) — mirrors
    # covenant.sh's STEP 4.4 (covenant.sh:667-682). A human commit (no
    # CLAUDECODE marker) is never subject to this friction. This is a
    # mechanical, file-existence gate — it does not require checkpoint_tool.py
    # (not ported to CovenantWin) to be installed, only that
    # .claude/checkpoints/LATEST.md exists before a large agent-authored
    # commit lands. Previously entirely absent from CovenantWin: the
    # README/MIGRATION docs describe checkpoint tooling as an "informs, never
    # blocks" enhancement layer, but this specific gate is a real blocking
    # check in covenant.sh, not the enhancement layer — its absence was a
    # genuine platform-parity gap, not a documented one.
    if trigger == 'pre-commit' and _is_claude_agent() and len(files) >= 5 and not (root/'.claude/checkpoints/LATEST.md').exists():
        return fail(f'Tier 3+ change footprint ({len(files)} files) with no brainstorming checkpoint. '
                     'Write a design brief to .claude/checkpoints/LATEST.md before committing.')
    # 2.6. Pre-push checkpoint covenant (agent-only) — mirrors covenant.sh's
    # STEP 4.6 (covenant.sh:717-741). Same rationale as above.
    if trigger == 'pre-push' and _is_claude_agent() and any(_looks_like_source(f) for f in files) \
            and not (root/'.claude/checkpoints/LATEST.md').exists():
        return fail('Agent push modifies source files without a checkpoint. Write a summary to '
                     '.claude/checkpoints/LATEST.md before crossing the remote push boundary.')
    # 3. Secrets scan (staged blob, not working tree). Line-based, with the
    # same placeholder/example/REDACTED exclusion covenant.sh applies to its own
    # diff-line scan — a documentation line demonstrating credential-shaped
    # syntax (common in onboarding/constitution content) is not itself a leak.
    for rel in files:
        # Installer-owned governance code contains the detection signatures
        # themselves; the integrity manifest protects these files at push.
        if rel in GOVERNANCE:
            continue
        blob=run(['git','show',':'+rel],root)
        if blob.returncode!=0: continue
        for line in blob.stdout.splitlines():
            if SECRET.search(line) and not _SECRET_EXCLUDE.search(line):
                return fail(f'secret-like material in staged file: {rel}')
    # 3.5. Fail closed, not silently, when source files changed but no test
    # command is configured. Mirrors covenant.sh's dynamic-stack-inference
    # fail-closed check (covenant.sh:998-1007) — but CovenantWin does not
    # auto-infer a test runner from repo topology the way covenant.sh does;
    # it relies entirely on /init-governance (or a human) populating
    # commands.test. Before this check existed, safe_command() silently
    # returned 0 for an empty/unconfigured command (see its own `if not
    # command: return 0`), meaning a Windows-governed repo could pass every
    # commit with zero tests ever run, no warning, and no way to tell from
    # the PASS output alone — a real, confirmed gap against covenant.sh's
    # documented "fail closed, never silent" guarantee. Scoped to files that
    # look like source (same classification as the layer-boundary scan) so
    # docs-only/config-only commits are never blocked by this. GOVERNANCE files
    # (covenantwin.py itself, a .py file) are excluded from the classification —
    # otherwise every fresh install's own commit (which stages
    # .githooks/covenantwin.py before commands.test is ever configured) would
    # immediately fail-closed-block itself.
    if any(_looks_like_source(f) for f in files if f not in GOVERNANCE) and not state['commands'].get('test'):
        return fail('source files changed but no test runner is configured '
                     '(set commands.test in .claude/covenant_state.json).')
    # 4. Lint (identity-based debt ratchet when baseline.json is populated —
    #    brownfield; zero-tolerance otherwise) + type check.
    timeout=int(state['thresholds'].get('command_timeout_sec',30))
    if _lint_with_ratchet(root, state, timeout): return 1
    if safe_command(state['commands'].get('type'),root,'type',timeout): return 1
    # 5. Layer boundaries.
    violations=[]
    for rel in files:
        p=root/rel
        if not p.is_file(): continue
        text=p.read_text(encoding='utf-8',errors='replace')
        low=rel.replace('\\','/').lower()
        if re.search(r'/(routes?|controllers?|presentation|views?|handlers?)/', '/'+low) and SQL.search(text): violations.append(rel+' contains SQL outside repositories')
        if re.search(r'/(services?|application|use.?cases?)/', '/'+low) and SQL.search(text): violations.append(rel+' contains SQL outside repositories')
        if re.search(r'/(services?|application|use.?cases?)/', '/'+low) and HTTP.search(text): violations.append(rel+' imports HTTP framework in service layer')
        if re.search(r'/(domain|entities)/', '/'+low) and DOMAIN_FW.search(text): violations.append(rel+' imports framework in domain layer')
    if violations: return fail('layer boundary violation(s): '+ '; '.join(violations[:5]))
    # 6. Tests and coverage: always at push/tier-3, otherwise opt-in.
    requested=os.environ.get('RUN_TESTS','').lower()=='true' or tier3 or trigger in ('pre-push', 'ci')
    if requested and safe_command(state['commands'].get('test'),root,'tests',timeout*10): return 1
    if requested and state['commands'].get('coverage') and safe_command(state['commands']['coverage'],root,'coverage',timeout): return 1
    # 7. Complexity and frontend checks.
    for key,label in [('complexity','complexity'),('frontend_lint','frontend lint'),('frontend_type','frontend type')]:
        if safe_command(state['commands'].get(key),root,label,timeout): return 1
    # 8. Receipt and auditable state.
    tree=run(['git','write-tree'],root).stdout.strip() if trigger=='pre-commit' else run(['git','rev-parse','HEAD^{tree}'],root).stdout.strip()
    if tree: state.setdefault('receipts',{})[tree]={'timestamp':dt.datetime.now(dt.timezone.utc).isoformat(),'branch':branch,'outcome':'pass'}
    state['last_pass_sha'][branch]=run(['git','rev-parse','HEAD'],root).stdout.strip(); state['last_pass_timestamp']=dt.datetime.now(dt.timezone.utc).isoformat()
    token['token_spent_today']+=active; token['token_audit_log']=(token.get('token_audit_log',[])+[{'timestamp':state['last_pass_timestamp'],'trigger':trigger,'outcome':'pass'}])[-1000:]
    atomic_json(sp,state)
    print(f'COVENANT PASS: all checks clean | branch={branch} | mode={mode} | tier3={str(tier3).lower()} | tests={"ran" if requested else "skipped"}',file=sys.stderr)
    return 0

def _write_integrity_manifest(root: Path):
    manifest = '\n'.join(hashlib.sha256((root/x).read_bytes()).hexdigest()+'  '+x for x in GOVERNANCE)+'\n'
    (root/'.claude/covenant_integrity.sha256').write_text(manifest, encoding='utf-8')

def _write_hook_shim(src: Path, dst: Path, trigger: str):
    # Reuses CovenantMac's actual pre-commit/pre-push scripts verbatim (SKIP_COVENANT
    # bypass with TTY/IDE-extension detection, git-notes audit trail on
    # pre-commit; force-push/bypass-refspec-tamper/protected-branch/24h-clock
    # guards on pre-push) — these are pure POSIX shell + git-notes plumbing,
    # nothing macOS-specific, and Git for Windows dispatches hooks through its
    # own bundled sh regardless of platform. Only the final delegation line
    # changes: instead of `exec .../covenant.sh`, it calls this engine directly —
    # removing the sh -> PowerShell -> Python hop the original CovenantWin hook
    # chain used (there is no separate PowerShell launcher script anymore).
    text = src.read_text(encoding='utf-8')
    old = f'COVENANT_TRIGGER={trigger} exec "$(git rev-parse --git-dir)"/../.githooks/covenant.sh'
    new = f'COVENANT_TRIGGER={trigger} exec python "$(git rev-parse --git-dir)"/../.githooks/covenantwin.py covenant --trigger {trigger}'
    if old not in text:
        raise RuntimeError(f'{src} did not contain the expected delegation line — CovenantMac template may have changed; update _write_hook_shim.')
    dst.write_text(text.replace(old, new), encoding='utf-8', newline='\n')

def _extract_prompt_block(init_pkg_path: Path) -> str:
    lines = init_pkg_path.read_text(encoding='utf-8').splitlines(keepends=True)
    start = next(i for i, l in enumerate(lines) if 'PROMPT START' in l) + 1
    end = next(i for i, l in enumerate(lines) if 'PROMPT END' in l)
    return ''.join(lines[start:end]).strip()

def _write_init_command(root: Path, init_pkg_dst_name: str):
    # One-command init — same mechanism as install.sh:_write_init_command:
    # extract the PROMPT START/END block and write it as a real slash command,
    # so the remaining manual step is "type /init-governance", not "open a
    # file, copy the right section, paste it".
    prompt_body = _extract_prompt_block(root/init_pkg_dst_name)
    description = (
        "One-time governance bootstrap (run once, immediately after install.ps1) — "
        "interrogates you about your stack and architecture, then writes CLAUDE.md, "
        f"layer scaffolding, and enforcement hooks. Source of truth: {init_pkg_dst_name}."
    )
    (root/'.claude/commands').mkdir(parents=True, exist_ok=True)
    (root/'.claude/commands/init-governance.md').write_text(description + "\n\n" + prompt_body + "\n", encoding='utf-8')

def _write_trust_root_settings(root: Path, dev_guide_dst_name: str, init_pkg_dst_name: str):
    settings_path = root/'.claude/settings.json'
    deny_extra = [f"Write({dev_guide_dst_name})", f"Edit({dev_guide_dst_name})",
                  f"Write({init_pkg_dst_name})", f"Edit({init_pkg_dst_name})"]
    # See install.sh's _ANCHOR comment: hook commands are registered as bare
    # repo-root-relative paths, and Claude Code's Bash tool persists cwd across
    # calls in a session, so anchoring to the toplevel keeps the hook working
    # regardless of what a prior tool call `cd`'d into.
    anchor = 'cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" && '
    bash_guard_entry = {
        "matcher": "Bash",
        "hooks": [{"type": "command", "command": anchor + "bash .claude/hooks/pre_bash_trust_root_guard.sh"}],
    }
    d = json.loads(settings_path.read_text(encoding='utf-8')) if settings_path.exists() else {}
    perms = d.setdefault('permissions', {})
    perms.setdefault('defaultMode', 'default')
    deny = perms.setdefault('deny', [])
    for e in REQUIRED_DENY + deny_extra:
        if e not in deny: deny.append(e)
    hooks = d.setdefault('hooks', {})
    pretool = hooks.setdefault('PreToolUse', [])
    has_guard = any(
        h.get('matcher') == 'Bash' and any('pre_bash_trust_root_guard.sh' in hh.get('command', '') for hh in h.get('hooks', []))
        for h in pretool
    )
    if not has_guard:
        pretool.append(bash_guard_entry)
    atomic_json(settings_path, d)

# CI parity backstop — installed into every governed TARGET repo as
# .github/workflows/covenant.yml, mirroring CovenantMac's templates/ci-covenant.yml. This
# is what still verifies an unbypassable covenant even if a developer deleted
# .githooks/ locally or pushed with --no-verify. runs-on ubuntu-latest is
# deliberate and sufficient here: the engine is pure Python with no
# Windows-specific behavior at covenant time, so there is nothing this job needs
# a Windows runner for, regardless of which platform's install.ps1/install.sh
# wrote it.
CI_WORKFLOW_TEMPLATE = """# CI parity covenant — installed by CovenantWin's install.ps1 into .github/workflows/covenant.yml
# Runs the committed covenantwin.py in CI mode so a hook-stripped clone (a developer who deleted
# .githooks or pushed with --no-verify) still cannot merge unverified code.
name: governance-covenant

on:
  pull_request:
    branches: [main, master, develop, "release/**", production]
  push:
    branches: [main, master, develop, "release/**", production]

permissions:
  contents: read

jobs:
  covenant:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout (full history - covenant needs diff range)
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.x"

      - name: Verify governance files are present, unmodified, and integrity-pinned
        run: python .githooks/covenantwin.py check-integrity .

      - name: Resolve base SHA for diff scope
        id: base_sha
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            echo "sha=${{ github.event.pull_request.base.sha }}" >> "$GITHUB_OUTPUT"
          else
            echo "sha=${{ github.event.before }}" >> "$GITHUB_OUTPUT"
          fi

      - name: Install target-repo dependencies (best-effort, language-agnostic)
        run: |
          set -uo pipefail
          [ -f requirements.txt ] && pip install -r requirements.txt
          [ -f pyproject.toml ] && pip install -e . || true
          [ -f package-lock.json ] && npm ci
          [ -f package.json ] && [ ! -f package-lock.json ] && npm install
          true

      - name: Run governance covenant (mechanical - tests forced on in CI)
        env:
          COVENANT_TRIGGER: ci
          RUN_TESTS: "true"
          CI_BASE_SHA: ${{ steps.base_sha.outputs.sha }}
        run: python .githooks/covenantwin.py covenant --trigger ci
"""

def _write_ci_workflow(root: Path, force: bool = False):
    p = root/'.github/workflows/covenant.yml'
    if p.exists() and not force:
        return False  # fresh install: never clobber a human's existing workflow
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(CI_WORKFLOW_TEMPLATE, encoding='utf-8', newline='\n')
    return True

def _write_codeowners(root: Path):
    p = root/'.github/CODEOWNERS'
    if p.exists(): return  # never overwrite a human's real content
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        "# Governance trust-root — requires Code Owner review before merge.\n"
        "# Scaffolded by CovenantWin's install.ps1; replace @your-org/platform-team with a real\n"
        "# team/user, then enable \"Require review from Code Owners\" on this repo's\n"
        "# default-branch protection rule (Settings -> Branches). CODEOWNERS alone is\n"
        "# advisory — GitHub does not enforce it without that branch protection rule.\n"
        "/.githooks/                         @your-org/platform-team\n"
        "/.claude/covenant_integrity.sha256      @your-org/platform-team\n"
        "/.claude/hooks/                     @your-org/platform-team\n"
        "/.claude/settings.json              @your-org/platform-team\n"
        "/.github/workflows/covenant.yml         @your-org/platform-team\n"
        "/CLAUDE.md                          @your-org/platform-team\n",
        encoding='utf-8',
    )

def _seed_baseline(root: Path):
    p = root/BASELINE_REL
    if p.exists(): return
    head = run(['git', 'rev-parse', 'HEAD'], root).stdout.strip() or 'INIT'
    atomic_json(p, {
        "_comment": "Identity-based debt baseline. covenantwin.py grandfathers these findings and "
                    "blocks any NEW identity. Identity = '<normalized_path>|<rule_code>'. "
                    "Committed team state — edited only via human-authored PR.",
        "ratchet_mode": "identity",
        "populated": False,
        "generated_at": None,
        "generated_from_sha": head,
        "lint_findings": [],
        "summary": {"lint_count": 0},
    })

def install(args):
    root=Path(args.path).resolve()
    if not (root/'.git').exists(): raise RuntimeError(f'{root} is not a Git repository.')
    source=Path(__file__).resolve()
    # Refuse to install into the Covenant framework repo itself (whether root IS the
    # standalone CovenantWin repo, or the Covenant monorepo root containing CovenantWin/) —
    # mirrors CovenantMac's install.sh:780-784 guard. Checking "does root contain the
    # engine that's currently running" rather than a fixed src/covenantwin.py path
    # keeps this correct regardless of how deeply CovenantWin is nested under the
    # target root. This exact mistake (installing CovenantWin onto its own checkout)
    # previously left real hook/state artifacts committed into this repo.
    if source.is_relative_to(root):
        raise RuntimeError(
            f'{root} contains the CovenantWin installer itself — not a target repo. '
            'cd into the repo you want to govern, then run install.ps1 from there.'
        )

    basket = getattr(args, 'basket', None)
    if basket not in ('greenfield', 'brownfield'):
        raise RuntimeError("--basket must be 'greenfield' or 'brownfield'.")

    # source = .../Covenant/CovenantWin/src/covenantwin.py when run from the framework
    # checkout (the only supported context for `install` — an already-installed
    # copy under a target repo's .githooks/ never re-invokes install()).
    covenant_root = source.parents[2]
    v1_release = covenant_root / 'v1_release'
    covenantmac_templates = covenant_root / 'CovenantMac' / 'templates'
    if basket == 'greenfield':
        dev_guide_src = v1_release/'basket-2-greenfield'/'v1_claude_code_development_guide_new.md'
        init_pkg_src = v1_release/'basket-2-greenfield'/'v1_implementation_package_new.md'
        dev_guide_dst_name, init_pkg_dst_name = 'v1_claude_code_development_guide_new.md', 'v1_implementation_package_new.md'
    else:
        dev_guide_src = v1_release/'basket-1-brownfield'/'v1_claude_code_development_guide_existing.md'
        init_pkg_src = v1_release/'basket-1-brownfield'/'v1_implementation_package_existing.md'
        dev_guide_dst_name, init_pkg_dst_name = 'v1_claude_code_development_guide_existing.md', 'v1_implementation_package_existing.md'
    if not dev_guide_src.exists() or not init_pkg_src.exists() or not covenantmac_templates.exists():
        raise RuntimeError(
            f'Shared content not found at {v1_release} / {covenantmac_templates} — this CovenantWin '
            'checkout must be part of the Covenant monorepo (CovenantWin/ and CovenantMac/ as siblings '
            'under a common Covenant/ root with v1_release/ shared at that root) for install to work.'
        )

    shutil.copy2(dev_guide_src, root/dev_guide_dst_name)
    shutil.copy2(init_pkg_src, root/init_pkg_dst_name)

    hooks = root/'.githooks'; hooks.mkdir(exist_ok=True)
    (root/'.claude/hooks').mkdir(parents=True, exist_ok=True)
    (root/'.claude/commands').mkdir(parents=True, exist_ok=True)
    (root/'.claude/checkpoints').mkdir(parents=True, exist_ok=True)

    # Copy the engine into the governed repository. Installed governance must
    # not retain any dependency on the CovenantWin checkout that installed it.
    installed_engine = hooks/'covenantwin.py'
    shutil.copy2(source, installed_engine)

    _write_hook_shim(covenantmac_templates/'pre-commit', hooks/'pre-commit', 'pre-commit')
    _write_hook_shim(covenantmac_templates/'pre-push', hooks/'pre-push', 'pre-push')

    # Trust-root Bash guard — the SAME .sh script CovenantMac deploys, used
    # as-is. Git for Windows is a hard CovenantWin requirement (see README), which
    # bundles bash; Claude Code's Bash tool is understood to run through that
    # same bash on Windows. Reusing the proven, tested guard rather than
    # writing an untested PowerShell-only equivalent is the safer choice for a
    # security-relevant script — see CovenantMac/docs/SECURITY_POSTURE.md for the
    # guard's own documented limits (lexical scanner, not a real interpreter).
    guard_text = (covenantmac_templates/'pre_bash_trust_root_guard.sh').read_text(encoding='utf-8')
    guard_text = guard_text.replace('__DEV_GUIDE_DST__', dev_guide_dst_name).replace('__INIT_PKG_DST__', init_pkg_dst_name)
    # CovenantMac's guard invokes `python3`, and its own `2>/dev/null || echo ""`
    # fallback means a MISSING python3 fails OPEN (silently allows every
    # command) rather than blocking — a real risk on Windows, where `python3`
    # is frequently absent or resolves to a non-functional Microsoft Store
    # stub while `python` works. Every other CovenantWin-deployed script already
    # invokes `python`, not `python3` (see _write_hook_shim) — normalize this
    # copy to match, rather than silently inheriting a fail-open on Windows.
    guard_text = guard_text.replace('python3', 'python')
    (root/'.claude/hooks/pre_bash_trust_root_guard.sh').write_text(guard_text, encoding='utf-8', newline='\n')

    _write_init_command(root, init_pkg_dst_name)
    _write_trust_root_settings(root, dev_guide_dst_name, init_pkg_dst_name)
    _write_codeowners(root)
    _write_ci_workflow(root)

    run(['git', 'config', 'core.hooksPath', '.githooks'], root)
    # Bypass note refspecs — same mechanism as install.sh:952-955, so the
    # audit trail replicates to the remote. `|| true`-equivalent: best-effort,
    # never blocks install if the remote/config isn't set up yet.
    run(['git', 'config', '--add', 'remote.origin.push', 'refs/notes/bypasses:refs/notes/bypasses'], root)
    run(['git', 'config', '--add', 'remote.origin.fetch', '+refs/notes/bypasses:refs/notes/bypasses'], root)

    sp = root/STATE_REL
    if not sp.exists():
        st = state_default()
        atomic_json(sp, st)

    if basket == 'brownfield':
        _seed_baseline(root)

    _write_integrity_manifest(root)

    gitignore = root/'.gitignore'
    entries = ['.claude/session_state.json', '.claude/session_spend.tmp', '.claude/git_cache.json', '.claude/checkpoints/']
    existing = gitignore.read_text(encoding='utf-8').splitlines() if gitignore.exists() else []
    with gitignore.open('a', encoding='utf-8') as f:
        for e in entries:
            if e not in existing:
                f.write(e + '\n')

    print(f'CovenantWin installed in {root} ({basket}). Git hooksPath is .githooks.')
    print(f'  Dev guide:    {dev_guide_dst_name}')
    print(f'  Init package: {init_pkg_dst_name}')
    print('  Init command: .claude/commands/init-governance.md')
    print('  Trust-root:   .claude/settings.json, .claude/hooks/pre_bash_trust_root_guard.sh')
    print('  Integrity:    .claude/covenant_integrity.sha256')
    print('  CODEOWNERS:   .github/CODEOWNERS (placeholder team - edit it)')
    if basket == 'brownfield':
        print('  Debt baseline: .claude/baseline.json (unpopulated - /init-governance fills it)')
    print('')
    print('Next: open Claude Code in this directory and run /init-governance.')
    return 0

def _write_reconcile_command(root: Path, dev_guide_dst_name: str, diff_text: str):
    # Same shape as _write_init_command / install.sh's _write_reconcile_command:
    # generates a real slash command rather than expecting a human to manually
    # diff and merge. Its job is explicitly NOT to regenerate CLAUDE.md wholesale
    # — that's human-customized by now — only propose-and-approve edits.
    description = (
        "Reconcile CLAUDE.md with a changed engineering-standard source "
        f"({dev_guide_dst_name}) — run after install.ps1 -Upgrade reports the dev "
        "guide's content changed."
    )
    instructions = f"""The engineering constitution's source ({dev_guide_dst_name}) changed content
during the last upgrade. CLAUDE.md was NOT touched automatically — it may contain
significant human-authored decisions by now, and a blind regeneration would lose them.

Read the diff below. For each substantive change (not formatting/wording-only
changes), propose a specific, individually-justified edit to CLAUDE.md: quote the
current text, propose the replacement, and give a one-line reason tied to what
actually changed in the source. Group proposals so each can be approved or
rejected independently — never present this as one big diff to rubber-stamp.

Do NOT edit CLAUDE.md until at least one proposed edit is explicitly approved.
Do NOT regenerate CLAUDE.md wholesale under any circumstance — every edit must be
traceable to a specific change in the diff below, not a fresh read of the whole
updated guide.

--- DIFF: {dev_guide_dst_name} (old vs. new) ---
{diff_text}
--- END DIFF ---
"""
    (root/'.claude/commands').mkdir(parents=True, exist_ok=True)
    (root/'.claude/commands/reconcile-governance.md').write_text(description + "\n\n" + instructions, encoding='utf-8')

def upgrade(args):
    root = Path(args.path).resolve()
    if not (root/STATE_REL).exists():
        raise RuntimeError('--upgrade requires an existing governed repo (.claude/covenant_state.json not found).')
    source = Path(__file__).resolve()
    if source.is_relative_to(root):
        raise RuntimeError(f'{root} contains the CovenantWin installer itself — not a target repo.')

    covenant_root = source.parents[2]
    v1_release = covenant_root / 'v1_release'
    covenantmac_templates = covenant_root / 'CovenantMac' / 'templates'

    hooks = root/'.githooks'; hooks.mkdir(exist_ok=True)
    (root/'.claude/hooks').mkdir(parents=True, exist_ok=True)

    # Unconditional: re-copy the engine + hook shims regardless of basket
    # detection below, mirroring install.sh's _write_hooks call at the top of
    # its own _upgrade().
    shutil.copy2(source, hooks/'covenantwin.py')
    _write_hook_shim(covenantmac_templates/'pre-commit', hooks/'pre-commit', 'pre-commit')
    _write_hook_shim(covenantmac_templates/'pre-push', hooks/'pre-push', 'pre-push')
    print('Hooks and engine refreshed.')

    # Detect basket from whichever dev-guide filename is present — this repo
    # never re-runs basket selection on upgrade.
    greenfield_guide = root/'v1_claude_code_development_guide_new.md'
    brownfield_guide = root/'v1_claude_code_development_guide_existing.md'
    if greenfield_guide.exists():
        dev_guide_dst_name, init_pkg_dst_name = greenfield_guide.name, 'v1_implementation_package_new.md'
        basket_dir = 'basket-2-greenfield'
    elif brownfield_guide.exists():
        dev_guide_dst_name, init_pkg_dst_name = brownfield_guide.name, 'v1_implementation_package_existing.md'
        basket_dir = 'basket-1-brownfield'
    else:
        dev_guide_dst_name = None
        print('WARNING: could not detect basket (no dev guide found) - skipping dev-guide/trust-root refresh. '
              'Run install with a fresh basket if this repo predates the dev-guide copy step.', file=sys.stderr)

    if dev_guide_dst_name:
        dev_guide_path = root/dev_guide_dst_name
        old_content = dev_guide_path.read_text(encoding='utf-8') if dev_guide_path.exists() else ''
        shutil.copy2(v1_release/basket_dir/dev_guide_dst_name, dev_guide_path)
        shutil.copy2(v1_release/basket_dir/init_pkg_dst_name, root/init_pkg_dst_name)

        guard_text = (covenantmac_templates/'pre_bash_trust_root_guard.sh').read_text(encoding='utf-8')
        guard_text = guard_text.replace('__DEV_GUIDE_DST__', dev_guide_dst_name).replace('__INIT_PKG_DST__', init_pkg_dst_name).replace('python3', 'python')
        (root/'.claude/hooks/pre_bash_trust_root_guard.sh').write_text(guard_text, encoding='utf-8', newline='\n')

        _write_init_command(root, init_pkg_dst_name)
        _write_trust_root_settings(root, dev_guide_dst_name, init_pkg_dst_name)
        print('Trust-root settings.json and /init-governance checked/backfilled.')

        new_content = dev_guide_path.read_text(encoding='utf-8')
        if old_content and old_content != new_content:
            diff_text = ''.join(difflib.unified_diff(
                old_content.splitlines(keepends=True), new_content.splitlines(keepends=True),
                fromfile=f'{dev_guide_dst_name} (old)', tofile=f'{dev_guide_dst_name} (new)',
            ))
            _write_reconcile_command(root, dev_guide_dst_name, diff_text)
            print('/reconcile-governance generated - the dev guide content changed; review before CLAUDE.md drifts further.')

    _write_codeowners(root)  # backfills if missing; never overwrites real content
    # CI workflow is force-overwritten on upgrade (unlike fresh install, which skips if present).
    _write_ci_workflow(root, force=True)
    print('CI governance workflow updated (.github/workflows/covenant.yml).')

    _write_integrity_manifest(root)
    print('Integrity manifest re-pinned (.claude/covenant_integrity.sha256).')

    sp = root/STATE_REL
    state = load(sp, state_default())
    old_version = state.get('framework_version', '0.0.0-win')
    state['framework_version'] = '1.0.0-win'
    state['framework_last_upgrade'] = dt.datetime.now(dt.timezone.utc).isoformat()
    atomic_json(sp, state)

    print('')
    print(f'CovenantWin upgrade complete: framework_version {old_version} -> {state["framework_version"]}')
    print('Preserved: .claude/baseline.json, CLAUDE.md, covenant_state.json receipts/token/thresholds/core_files.')
    print('This upgrade re-pinned .claude/covenant_integrity.sha256 - CI will fail until the new manifest')
    print('is committed alongside every file it covers. Get this reviewed like any other change to the')
    print('enforcement boundary, not rubber-stamped.')
    print('')
    print('Commit the upgrade to activate it for the whole team:')
    print('  git add .githooks .claude/covenant_integrity.sha256 .claude/settings.json .claude/hooks '
          '.claude/commands .github/workflows/covenant.yml .claude/covenant_state.json '
          + (dev_guide_dst_name or '') + ' ' + (init_pkg_dst_name if dev_guide_dst_name else ''))
    print("  git commit -m 'chore: upgrade CovenantWin governance framework to 1.0.0-win'")
    return 0

def main():
    p=argparse.ArgumentParser(prog='covenantwin'); sub=p.add_subparsers(dest='cmd',required=True)
    i=sub.add_parser('install')
    i.add_argument('path',nargs='?',default='.')
    i.add_argument('--basket', choices=['greenfield', 'brownfield'], required=True)
    i.set_defaults(fn=install)
    g=sub.add_parser('covenant'); g.add_argument('--trigger',choices=['pre-commit','pre-push','ci'],required=True); g.set_defaults(fn=lambda a:covenant(a.trigger))
    ci=sub.add_parser('check-integrity'); ci.add_argument('path',nargs='?',default='.')
    ci.set_defaults(fn=lambda a: check_integrity(Path(a.path).resolve()))
    up=sub.add_parser('upgrade'); up.add_argument('path',nargs='?',default='.'); up.set_defaults(fn=upgrade)
    a=p.parse_args()
    try: return a.fn(a) or 0
    except Exception as e: return fail('internal failure (fail closed): '+str(e))
if __name__=='__main__': sys.exit(main())
