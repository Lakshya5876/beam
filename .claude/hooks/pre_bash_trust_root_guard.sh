#!/usr/bin/env bash
# PreToolUse guard (Bash matcher) — blocks any Bash command that references a
# trust-root governance path, regardless of shell construct (redirection, tee,
# sed -i, python, etc.). Native permissions.deny is prefix-matched only and
# cannot express "the command mentions this path anywhere" — a static deny
# list can never fully close that gap, so this hook inspects the actual
# command text instead. Receives tool input JSON on stdin.
#
# v1_claude_code_development_guide_existing.md and v1_implementation_package_existing.md are placeholder tokens substituted by
# install.sh's _write_trust_root_settings at deploy time — this file is
# otherwise fully static, which is why it lives in templates/ rather than as
# an inline install.sh heredoc: the bats suite can deploy this exact file
# (with test-repo substitutions) and exercise the real matching logic
# directly, instead of a hand-copied mirror or a no-op stub.
set -euo pipefail

CMD=$(python -c "import json,sys; print(json.load(sys.stdin).get('tool_input', {}).get('command', ''))" 2>/dev/null || echo "")
[ -z "$CMD" ] && exit 0

export _TRUST_ROOT_GUARD_CMD="$CMD"

python - <<'PYEOF'
import os
import re
import shlex
import sys

CMD = os.environ.get("_TRUST_ROOT_GUARD_CMD", "")

# Original literal form (used for the fast substring pass AND for the block
# message, so the text an engineer sees never changes) alongside a
# trailing-slash-stripped form (used for lexical path comparison in the
# cd-tracking pass below — a directory and its trailing-slash marker are the
# same path for that purpose).
PROTECTED_SUBSTR = [
    ".githooks/",
    ".claude/hooks/",
    ".claude/covenant_integrity.sha256",
    ".claude/covenant_state.json",
    ".github/workflows/covenant.yml",
    ".mcp.json",
    "v1_claude_code_development_guide_existing.md",
    "v1_implementation_package_existing.md",
]
# ".claude/hooks/" self-protects this very script — an agent that overwrites
# it with a no-op would leave its PreToolUse registration in settings.json
# looking intact while the guard silently does nothing. ".claude/covenant_state.json"
# is the covenant's own ledger (receipts, token spend, audit log); an agent that
# can Write/Edit it directly can fabricate a passing receipt or reset its own
# token budget, which defeats every other control in this chain. ".mcp.json"
# controls which MCP servers Claude Code connects to.
#
# Deliberately excludes .claude/settings.json, CLAUDE.md, and
# .claude/baseline.json: the init prompt legitimately needs to reference
# these via Bash/python during its own generation and merge steps (reading
# current state, programmatic JSON edits). Blocking all mentions of them here
# would block the init prompt from ever doing its job. Those three get their
# write/edit protection from permissions.deny instead, added as the init
# prompt's FINAL step — see the "MERGE, do not regenerate" note in the
# implementation package. Also excludes .claude/checkpoints/ and
# .claude/commands/ and .claude/session_state.json: all three are legitimately
# written by the agent on an ongoing basis (checkpoint protocol, command file
# generation, session tracking) as part of normal operation, not just at init.

def _norm(path):
    n = os.path.normpath(path)
    return "" if n in (".", "") else n.lstrip("./")

# stripped-path -> original display form, for the cd-tracking pass below.
_DISPLAY = {_norm(p): p for p in PROTECTED_SUBSTR}
PROTECTED_PATHS = list(_DISPLAY.keys())


def _block(display_path):
    sys.stderr.write(
        "COVENANT: Bash commands referencing trust-root path '%s' are blocked — "
        "these files constrain the agent and may only be changed via "
        "human-authored PR.\n" % display_path
    )
    sys.exit(1)


# Fast path: a literal substring match, exactly as before — cheap, and
# catches the overwhelming majority of real cases (the file path appears
# somewhere in the command text, whatever surrounds it).
for p in PROTECTED_SUBSTR:
    if p in CMD:
        _block(p)


def _protected_hit(path, cwd):
    # Usage: does `path`, resolved against the virtual `cwd`, land inside (or
    # exactly on) a protected path? Purely lexical (os.path.normpath on
    # strings) — never touches the real filesystem, so it works identically
    # whether or not the target actually exists yet.
    if not path or path.startswith("-"):
        return None
    resolved = path if path.startswith("/") else os.path.join(cwd, path)
    resolved = _norm(resolved)
    if not resolved:
        return None
    for pp in PROTECTED_PATHS:
        if resolved == pp or resolved.startswith(pp + "/"):
            return pp
    return None


# Slow path: closes the `cd`-indirection gap a pure substring match cannot
# see. `cd .githooks && sed -i '1a exit 0' covenant.sh` never puts the literal
# text ".githooks/covenant.sh" (or even ".githooks/") anywhere in the command
# string — the directory and the filename are two separate shell tokens
# joined only by the shell's own cwd tracking — so the fast path above misses
# it entirely. This was a real, confirmed bypass: it neutered the covenant with
# no permission prompt and no denial. Tracks a virtual cwd across `cd` calls
# within the same command string (split on the shell operators that start a
# new command) and re-checks every non-flag argument against it.
#
# Known limitations, stated up front: `cd -` is refused outright rather than
# silently mistracked (OLDPWD isn't available to a static analyzer); shell
# variables/`~`/command substitution in a `cd` target or a later argument
# are not expanded, so `D=.githooks; cd "$D"` evades this pass specifically
# (the same fundamental limit as any lexical, non-executing scanner — see
# covenant.sh's _is_claude_agent_process for the same class of documented,
# non-closable gap). This closes the realistic, demonstrated bypass class,
# not every conceivable one.
segments = re.split(r'&&|\|\||;|\n|\|', CMD)
cwd = "."
for seg in segments:
    seg = seg.strip()
    if not seg:
        continue
    try:
        tokens = shlex.split(seg, posix=True)
    except ValueError:
        tokens = seg.split()
    if not tokens:
        continue
    if tokens[0] == "cd" and len(tokens) > 1:
        target = tokens[1]
        if target == "-":
            sys.stderr.write(
                "COVENANT: 'cd -' cannot be tracked by this guard — split the "
                "command so each `cd` target is an explicit path.\n"
            )
            sys.exit(1)
        hit = _protected_hit(target, cwd)
        cwd = target if target.startswith("/") else (_norm(os.path.join(cwd, target)) or ".")
        if hit:
            _block(_DISPLAY[hit])
        continue
    for tok in tokens[1:]:
        hit = _protected_hit(tok, cwd)
        if hit:
            _block(_DISPLAY[hit])

sys.exit(0)
PYEOF
