# FocusGuard

[Chinese](README.zh-CN.md) · English

Guardrails for AI coding agents, enforced at the hook layer. Four behaviours that make agents dangerous stop being prompt advice and become mechanically blocked events: **editing without reading first**, **conclusions without `[file:line]` evidence**, **whole-file reads that burn context**, and **asserting findings that were never verified**. A hit escalates through L1 push-back → L2 forced evidence → L3 fuse → L4 record → L5 downgrade → L6 report.

- **Zero dependencies** — the core package ships no runtime libraries (`dependencies` is empty)
- **Two enforcement surfaces** — a native DSH plugin (host hooks) plus the ZCode hook shell
- **Full audit trail** — every block is appended to `.focus-guard/AUDIT.log` (JSONL, rotated and archived)
- **Auditable rules** — `docs/RULES.md` marks which clauses are machine-enforced and which are not yet implemented

## Install

### DSH (native plugin, recommended)

```bash
dsh plugin --profile <your-profile> add github:irisblackwood/focus-guard#path:/packages/core
```

Restart the session to activate. The bundle patch is declared by this package's `package.json` (`dsh.bundle.patch` → `src/dsh/cordis.patch.yml`).

> **Not on npm yet.** `npm install focus-guard` returns 404 — the package has never been published. Use the GitHub install above; it is the only supported route today.

⚠ Mutually exclusive with the official bridge (`@deepseek-ai/dsh-hooks-claude-code`). Mounting both double-runs the same hooks — pick one.

### ZCode

`.zcode-plugin/plugin.json` is ready; import this repository through ZCode's plugin flow.

## What it blocks

| Situation | Mechanism |
|---|---|
| Editing files or running mutating commands without investigating first | Layer 4 precondition: the target must have been read in this session, otherwise one refusal (new files exempt) |
| High-risk commands (recursive delete, format, force-push, publish, global install, system-path writes) | Layer 3 eligibility: **apply before execute**, denied without a grant; `fg_apply` is the request channel |
| Absolute red lines (`rm -rf /`, `DROP DATABASE`, `git push -f`) | Layer 1 zero-latency short-circuit denial, **no approval prompt** |
| Dangerous command strings that are merely **quoted** (test data, docs, eval fixtures) | Context exemption on three criteria (quoted / data marker / read-only command) → downgraded to semantic judgement instead of a hard denial |
| Wrongly blocked, no appeal path | `fg_appeal`: submit counter-evidence anchors, one human ruling, fully recorded |
| One-size-fits-all across models | Model profiles (`src/profiles/`): review intensity follows the model |
| Writing `grep`/`find` when the machine wants `rg`/`fd` | Environment fingerprint + hard command check, one-line substitution hint |

## Runtime additions (in-tree, 2026-10-18)

Shipped in the code, not yet reflected in the version number (still `3.0.6`):

- **Heartbeat and liveness** — `src/dsh/heartbeat.mjs:85`, `src/dsh/status.mjs:73`: every 10s the plugin atomically rewrites `.focus-guard/status.json`; `node src/dsh/status.mjs` reports `ALIVE` / `STALE` and exits `0` all-green, `2` module missing, `3` stale, `4` no file.
- **Module self-check** — `heartbeat.mjs:45`: the ten enforcement seams plus the heartbeat each report at startup; anything missing lands in `degraded`, is warned to the host log, and is injected to the model as `focus-guard-degraded`.
- **L4 cross-session record** — `src/dsh/workspace.mjs:38` (hash) / `:125` (turn record) / `src/dsh/index.js:71` (injection): state is keyed by `sha256(realpath(cwd))`; a hash mismatch injects nothing, so a renamed folder cannot inherit old state.
- **Whole-file read gate** — `src/dsh/pipeline.mjs:421` / `:645`: a target above 300 lines read without `offset`/`limit` is denied and pointed at XERJ (`xerj search` / `xerj def`). Configurable via `FG_WHOLE_FILE_MAX_LINES`.
- **Superpowers writing gate** — `src/dsh/pipeline.mjs:398`: a vague development request (dev verb + vague marker + no acceptance criteria) gets one denial before the first edit/write/destructive shell, requiring `brainstorming` or `writing-plans`; a retry or a loaded skill passes.
- **Graded destructive heuristic** — `src/dsh/pipeline.mjs:159`: `Remove-Item` / `fs.rmSync` weight by target — system path or recursive `0.9` (blocked), TEMP `0.2`, other `0.4`; redirection `0.15`.
- **Compaction watch** — `src/dsh/compactionWatch.mjs:239` / `:364`: observes `compaction/start|end|prune` and request-error collisions, records them, and never writes surface or cancels a turn.
- **Denial reasons in the audit** — `src/dsh/audit.mjs:120`: `auditDeny(exec, cmd, {trigger, level})` records the real rule (`redline:<name>`, `env-substitute`, `gate:fg_apply`, `evidence-gate`, `whole-file:lines`, `risk:<category>`) instead of a constant `high-risk-rm`.
- **Executor detection** — `src/core/env.mjs:18` + `src/dsh/index.js:31`: the master layer honours an explicit `FG_SHELL`; the DSH adapter declares `powershell`, ending the three-way mismatch between record, fingerprint and actual executor.
- **Audit isolation guard** — `tests/audit-isolation.mjs:1`: snapshots the real `AUDIT.log` before the suites run and fails the run if it grew (verified both ways: clean Δ0 PASS, deliberate pollution Δ1 FAIL).

## Six-layer eligibility

| Layer | Question |
|---|---|
| L0 | Request completeness — empty `purpose` / `scope` is denied |
| L1 | State — fuse / downgrade / budget exhausted |
| L2 | Absolute red lines (denied here, never reaches L3) |
| L3 | High-risk eligibility — matches a high-risk signature with no grant in this session → human approval |
| L4 | Preconditions — mutating targets must be evidenced; system paths and `.git`/`node_modules` are stricter |
| L5 | Semantic signals — the model probe's `mismatch` / high-risk score |
| L6 | Grant and record |

## Three commands

```bash
npm test                    # acceptance (version consistency, docs-vs-implementation alignment)
npm run test:eligibility    # eligibility + red-line exemption + appeal
npm run eval                # threat evaluation (high-risk detection rate + benign false-positive rate)
```

## Architecture

```
src/core/           master layer: zero-dependency, host-agnostic judging logic
src/adapters/dsh/   adapter layer: wires the master into DSH (fg_apply / fg_appeal + eligibility gate)
src/dsh/pipeline.mjs host hooks: pre-execute / system-prompt / post-execute
hooks/guard.mjs     ZCode execution shell (sealed: independent version, does not follow the main release)
```

**Layering rule**: the master layer must not depend back on the adapter layer (locked by an acceptance test).

## Version

Currently `3.0.7`. Eight version surfaces are asserted equal to each other and to the latest `CHANGELOG.md` entry.

## Docs

- Capabilities and troubleshooting: repository `README.md`, `INSTALL.md`
- Rule text: `docs/RULES.md`
- Changelog: repository `CHANGELOG.md`

## License

MIT © 2026 irisblackwood
