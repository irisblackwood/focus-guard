# Keepward

> **状态**：参考 · 适用版本 3.5.0 · 最后核对 2026-11-17

> Formerly **FocusGuard**. Renamed in 3.5.0 — the package name `focus-guard`, the plugin id,
> the `.focus-guard/` state directory and the `FG_*` environment variables are **unchanged**.

[Chinese](README.zh-CN.md) · English

Guardrails for AI coding agents, enforced at the hook layer. Three kinds of runaway stop being prompt advice and become mechanically blocked events:

- **Thinking** — a conclusion with no `[file:line]` evidence is pushed back before it ships
- **Resources** — whole-file reads and repeated no-op reads burn context; both are gated
- **Permissions** — `rm -rf` / `git push -f` / `npm publish` need a grant *before* they run, not an apology after

Every block is appended to `.focus-guard/AUDIT.log` (JSONL) with the rule that actually fired. Nothing here asks the model to behave; it changes what the model is allowed to do.

## Install

### DSH (native plugin, recommended)

```bash
dsh plugin --profile <your-profile> add github:irisblackwood/focus-guard#path:/packages/core
```

Restart the session to activate. The bundle patch is declared by this package's `package.json` (`dsh.bundle.patch` → `src/dsh/cordis.patch.yml`).

> **Mutually exclusive** with the official bridge (`@deepseek-ai/dsh-hooks-claude-code`). Both mount the same seams; mounting both double-runs every hook — pick one.

### npm

```bash
npm install focus-guard
```

### ZCode

`.zcode-plugin/plugin.json` is ready; import this repository through ZCode's plugin flow. The execution shell is sealed — it carries its own version and does not follow the main release.

## What it blocks

| Situation | Mechanism |
|---|---|
| Editing files or running mutating commands without investigating first | L4 precondition: the target must have been read in this session, otherwise one refusal (new files exempt) |
| High-risk commands (recursive delete, format, force-push, publish, global install, system-path writes) | L3 eligibility: **apply before execute**, denied without a grant; `fg_apply` is the request channel |
| Absolute red lines (`rm -rf /`, `DROP DATABASE`, `git push -f`) | L2 zero-latency short-circuit denial, **no approval prompt** |
| Dangerous strings that are merely **quoted** (test data, docs, eval fixtures) | Context exemption on three criteria (quoted / data marker / read-only command) → downgraded to semantic judgement, never waved through |
| Wrongly blocked, no appeal path | `fg_appeal`: submit counter-evidence anchors, one human ruling, fully recorded |
| Whole-file read of a large target | Above `FG_WHOLE_FILE_MAX_LINES` (default 300) without `offset`/`limit` → denied, pointed at XERJ |
| Vague development request, straight to editing | One refusal before the first write, requiring `brainstorming` or `writing-plans` |
| One-size-fits-all across models | Model profiles (`src/profiles/`): review intensity follows the model |
| Writing `grep`/`find` when the machine wants `rg`/`fd` | Environment fingerprint + hard command check, one-line substitution hint |

## How it decides

Six layers, in order. A profile may skip layers; it may never disable L2 or L3.

| Layer | Question |
|---|---|
| L0 | Request completeness — empty `purpose` / `scope` is denied |
| L1 | State — fuse / downgrade / budget exhausted |
| L2 | Absolute red lines (denied here, never reaches L3) |
| L3 | High-risk eligibility — matches a high-risk signature with no grant in this session → human approval |
| L4 | Preconditions — mutating targets must be evidenced; system paths and `.git`/`node_modules` are stricter |
| L5 | Semantic signals — the model probe's `mismatch` / high-risk score |
| L6 | Grant and record |

## What else is running

All shipped. Module paths carry no line numbers on purpose — those rot silently.

- **Heartbeat and liveness** — `src/dsh/heartbeat.mjs`, `src/dsh/status.mjs`: every 10s the plugin atomically rewrites `.focus-guard/status.json`; `node src/dsh/status.mjs` reports `ALIVE` / `STALE` and exits `0` all-green, `2` module missing, `3` stale, `4` no file.
- **Module self-check** — `src/dsh/heartbeat.mjs`: the ten enforcement seams plus the heartbeat each report at startup; anything missing lands in `degraded`, is warned to the host log, and is injected to the model as `focus-guard-degraded`.
- **Cross-session record** — `src/memory/workspace.mjs`: state is keyed by `sha256(realpath(cwd))`; a hash mismatch injects nothing, so a renamed folder cannot inherit old state.
- **Compaction watch** — `src/dsh/compactionWatch.mjs`: observes `compaction/start|end|prune` and request-error collisions, and measures how many anchors (paths, line refs, error codes, constants) a summary kept versus the original. Read-only: never writes a surface, never cancels a turn.
- **Prefix stability** — `src/core/prefixStability.mjs`: fingerprints the assembled prompt prefix each turn and records shifts, so a cache-breaking change shows up as an audit event instead of on an invoice.
- **Graded destructive heuristic** — `src/dsh/guard/risk.mjs`: `Remove-Item` / `fs.rmSync` weight by target — system path or recursive `0.9` (blocked), TEMP `0.2`, other `0.4`; redirection `0.15`.
- **Denial reasons in the audit** — `src/dsh/audit.mjs`: `auditDeny(exec, cmd, {trigger, level})` records the real rule (`redline:<name>`, `env-substitute`, `gate:fg_apply`, `evidence-gate`, `whole-file:lines`, `risk:<category>`) instead of a constant `high-risk-rm`.
- **Executor detection** — `src/core/env.mjs`, `src/dsh/index.js`: the master layer honours an explicit `FG_SHELL`; the DSH adapter declares `powershell`, ending the three-way mismatch between record, fingerprint and actual executor.
- **Audit isolation guard** — `tests/audit-isolation.mjs`: snapshots the real `AUDIT.log` before the suites run and fails the run if it grew.

## Architecture

```
src/core/            master layer: zero-dependency, host-agnostic judging logic (26 modules)
src/adapters/dsh/    adapter layer: wires the master into DSH (fg_apply / fg_appeal + eligibility gate)
src/dsh/             host seams: pipeline.mjs orchestrates 8 events; guard/ holds the per-layer gates
src/memory/          cross-session record, tags, workspace hashing
src/profiles/        five pure-parameter model profiles
hooks/guard.mjs      ZCode execution shell (sealed: independent version)
```

**Layering rule**: the master layer must not depend back on the adapter layer (locked by an acceptance test). Dependency direction is `core → adapters → seams`, one way only.

## Commands

```bash
npm test                    # full suite, run inside an audit sandbox
npm run test:eligibility    # eligibility + red-line exemption + appeal
npm run eval                # threat evaluation (detection rate + benign false-positive rate)
npm run check               # everything the release gate runs
```

## Version

Three numbers, three meanings — do not mix them:

| Surface | Value | Meaning |
|---|---|---|
| npm registry | `3.5.0` | last `npm publish` (2026-11-17, OIDC trusted publishing + provenance) |
| GitHub `main` | `3.5.0` | `PUBLISHED_MAX` — what "released" means for this project |
| This tree | `3.5.0` | level with released; unpushed work runs ahead, and ahead is not released |

## Docs

- Capabilities, code anchors, gaps: `docs/ARCH-MAP.md`
- Rule text, and which clauses are machine-enforced: `docs/RULES.md`
- Mechanism walkthrough: repository `docs/ARCHITECTURE.md`
- Changelog: repository `CHANGELOG.md`

## License

AGPL-3.0-only © 2026 irisblackwood — a commercial license is available as an
alternative to the AGPL (e.g. to avoid section 13's source-offer obligation);
it is not required in order to comply with the AGPL.
