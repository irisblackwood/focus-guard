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

Currently `3.0.6`. Eight version surfaces are asserted equal to each other and to the latest `CHANGELOG.md` entry.

## Docs

- Capabilities and troubleshooting: repository `README.md`, `INSTALL.md`
- Rule text: `docs/RULES.md`
- Changelog: repository `CHANGELOG.md`

## License

MIT © 2026 irisblackwood
