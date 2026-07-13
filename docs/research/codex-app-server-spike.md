# Pinned Codex app-server subscription-path spike

Date: 2026-07-13
Status: CX-001 implementation and evidence complete at sealed checkpoint;
guarded landing remains. This is not a production adapter or a requirement
promotion.

## Executive result

PC-SDK Next can directly launch the stable native app-server from exact package
`@openai/codex@0.144.1`, speak its non-experimental stdio JSONL protocol through
a bounded provider-local client, and dispose the directly owned child with
positive exit, close, stream-drain, and decoder-finish evidence.

The explicitly approved no-turn live gate observed an exact existing credential
home using the forced file credential store, cached ChatGPT auth kind, built-in
OpenAI catalog routing, and one advertised visible default model with a supported
default effort. A distinct second native process repeated the same admission and
returned the same advertised default: `gpt-5.6-sol` with `medium` effort. Both
processes and the disposable workspace closed cleanly. No thread, turn, login,
logout, tool, MCP, approval, context, quota, or inference method was called.

This proves only a bounded admission dependency. It does not prove credential
freshness, entitlement, subscription usability, billing route, model usability,
or a production `CodexRuntimeAdapter`.

## Source and checkpoint

- Base: `dea2df76ff623ec96123b61ca6b9ab5f8aa8d639`.
- Branch: `codex/cx-001-codex-subscription-spike`.
- Contract commits: `02135481c579109a7a5014e004525450562e975a`,
  `27d5ea5482076dd26509f789c0d5079b65c0eb6f`, and
  `8c15023e95bd3dfd1143d37c924fb4022f6e4c30`.
- Sealed implementation: `648b7d971c34ccf36985d84c0d20155e5eacf7d3`.
- Sealed tree: `2e10894429d4a99cce91b3665b45585240c52bde`.
- Package/native CLI: `@openai/codex@0.144.1` / `codex-cli 0.144.1`.
- Stable generated TypeScript schema: 598 files; inventory hash
  `sha256:96edfa58afbd0925a74a4e7575df581c05525567965b44d61cdf2fc43d8eb5f8`;
  tree hash
  `sha256:bd4ea5dcabc98ffb47f566a2c7f5c44b896b7d681372769fbcfe22216bc34faa`.

The checked sources were the pinned
[app-server README](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/app-server/README.md),
the pinned
[configuration schema](https://raw.githubusercontent.com/openai/codex/rust-v0.144.1/codex-rs/core/config.schema.json),
and official [authentication](https://learn.chatgpt.com/docs/auth) and
[app-server](https://learn.chatgpt.com/docs/app-server) documentation. The
generated pinned schema and observed stable serialization win over remembered
event shapes. Any Codex upgrade invalidates this checkpoint until schema
regeneration, provider-free tests, hostile review, and the bounded live gate are
repeated.

## Authorized no-turn sequence

1. Resolve the repository-pinned native optional dependency; launch it directly
   with no shell, wrapper, or PATH lookup and with `detached: false`.
2. Start from the shared positive child-environment allowlist, add only the exact
   canonical existing `CODEX_HOME`, and pass the literal CLI override
   `-c cli_auth_credentials_store="file"`.
3. Send `initialize` with experimental APIs and request attestation disabled;
   require the exact returned home, then send `initialized`.
4. Require the stable remote-control snapshot to be `disabled` with no bound
   environment.
5. Run `config/read` only against an empty disposable cwd with layers included.
   Require effective file-store provenance from one active, exact-version
   `sessionFlags` layer and reject custom provider, catalog, or endpoint routing.
6. Run `account/read` with exactly `refreshToken: false`; require
   `requiresOpenaiAuth: true` and cached account kind `chatgpt`.
7. Page `model/list` with `includeHidden: false`; require one visible default and
   require its default effort to occur in its advertised supported set.
8. Positively dispose the direct child, then repeat steps 1-7 in a distinct
   native process and require the exact same default model/effort observation.
9. Positively dispose the second child and remove the empty disposable workspace.

Pinned 0.144.1 may publish the remote-control snapshot while `initialize` is in
flight, so the client opens a new handshake epoch when initialization begins. In
the stable config response, unset built-in routing fields serialize as null or
empty collections, and `disabledReason` can be omitted from active layers. The
parsers admit those exact forms without weakening active provenance checks.

## Sanitized live observation

| Evidence | Sanitized result |
| --- | --- |
| Package | `@openai/codex@0.144.1` |
| Protocol | stable stdio JSONL; experimental disabled |
| Exact selected home | true; path omitted |
| Credential store | `file`; active matching `sessionFlags` provenance |
| Cached auth kind | `chatgpt`; identity and plan omitted |
| Catalog routing | built-in OpenAI |
| Advertised visible default | `gpt-5.6-sol` |
| Advertised supported default effort | `medium` |
| Distinct native restart | true |
| Restart catalog match | true |
| Direct cleanup | both children disposed; temporary root removed |
| Post-run guard | zero repository-owned Codex processes or disposable residue |

The post-run process guard is direct-process/run hygiene, not proof that an
escaped or reparented descendant cannot exist. No raw frame, account email,
plan, native identifier, config/origin payload, quota, provider prose, token, or
reasoning was retained.

## Provider-free and hostile evidence

- The complete focused Codex/schema/environment/static suite passes 153/153,
  including exact native schema regeneration.
- A native empty-home gate completes initialize and strict config admission,
  then stops at the expected redacted `account-admission-failed` result. It
  removes its workspace and leaves zero repository-owned Codex processes.
- The exact Windows root command is
  `pnpm --silent --config.shell-emulator=true spike:codex --codex-home
  "<exact-canonical-home>" --allow-live-provider`. Silent mode prevents a pnpm
  banner from echoing the home and the shell emulator preserves canonical
  backslashes.
- A system-temporary empty home caused pinned Codex to emit its helper-alias
  warning. The admission policy correctly failed on that stderr byte. The final
  provider-free gate used a disposable repository-local empty home; the policy
  was not weakened.
- Full feature-tree `pnpm ci:check` passes all workspace typechecks/tests,
  597/597 server tests, and the dead-import guard. The production web build
  passes.
- Three independent final hostile re-reviews report no remaining P0/P1/P2
  finding.

Hostile review drove concrete guards for file-store origin/layer version and
active-state correlation, strict routing/account/catalog response shapes,
single-read normalized request parameters, reentrant initialize/dispose,
cancelled response and EPIPE races, failed-spawn lifecycle precedence, trailing
output versus missing cleanup proof, silent Windows argument handling,
checkout-stable generated LF bytes, and static coverage of the thin live script.

## Capability and evidence matrix

| Surface | CX-001 result |
| --- | --- |
| Exact package/native/schema pin | positive |
| Exact-home file-store isolation | positive |
| Cached ChatGPT auth kind | positive observation only |
| Built-in advertised model/effort | positive observation only |
| Distinct restart and direct cleanup | positive |
| Credential freshness / entitlement / subscription usability | unavailable |
| Billing route / model usability / inference | unavailable |
| Production adapter / registration / composition | unavailable |
| Native create, resume, or continuation | unavailable |
| Terminal turns / interruption | unavailable |
| Approvals / tools / MCP | unavailable |
| Context / compaction / quota normalization | unavailable |
| Canonical event mapping / dispatch / cross-runtime handoff | unavailable |
| Escaped-descendant containment | unavailable; production-adapter blocker |

## Limitations and next checkpoint

Native startup or cached account/catalog reads may update provider-managed cache
files, so byte-level credential-home immutability is not claimed. The advertised
default is not a PC-SDK product default. This slice promotes no requirement and
does not change production composition, persistence, selectors, sessions, or UI.

The next bounded contract is a provider-local `CodexRuntimeAdapter` and shared
provider-free conformance/containment work. Production registration, selector or
handoff UI, and a live thread/turn remain unauthorized until pre-execution
tool/MCP/approval enforcement and escaped-descendant containment have positive
receipts.
