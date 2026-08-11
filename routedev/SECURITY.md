# RouteDev security policy

## Scope

This policy covers the desktop product under `routedev/`, the loopback/LAN remote gateway, the Android remote client, update delivery, and the associated IPC and protocol packages. Historical material under `archive/`, `refs/`, prototypes, and reports is not a supported runtime surface.

The remote gateway is disabled by default. When enabled, pairing, device scopes, per-session ACL, the PermissionEngine, OS sandbox rules, SSRF protection, and the audit chain remain mandatory. Remote approvals and remote autonomy changes are disabled by default.

## Effect-aware tool authorization

Authorization is based on resource effects, not only tool names. Built-in file, Git, shell, process, and network tools resolve to known effects; tools that cannot prove their effect are treated as opaque and do not silently inherit mutation authority. File identities are canonicalized through existing parents so relative paths, `..`, slash variants, Windows case, symlinks, junctions, and not-yet-created targets converge on the same policy identity.

A run-scoped denied-intent ledger carries authoritative resource denials across equivalent tool substitutions. Parallel batches resolve and authorize every call before execution, then serialize canonical write conflicts. Tool-call repair is authorized only after its final arguments are known. Mutating built-ins repeat the permission-kernel check immediately before the operating-system action to narrow check/use races. A hostile process can still swap a filesystem object after that final check; OS sandboxing and least-privilege workspace boundaries remain required defense in depth.

Shell analysis is deliberately partial and fail-closed. Redirects, bounded file operations, interpreter wrappers, and targeted Git mutations resolve to resource effects; unbounded Git mutations and unproven scripts remain opaque. Verifier recognition requires a standalone verifier invocation and rejects update/fix/output modes. Package-manager verifier scripts still execute repository-controlled code, so the workspace sandbox and least-privilege process environment remain part of the security boundary.

## Completion evidence

For repository-changing work, a task contract records concrete obligations and their evidence. Mutations advance an epoch, and verification evidence is valid only for the current epoch, so tests run before the last write cannot prove completion. An authoritative policy denial can mark only its matching resource obligation as blocked; user or hook rejection cannot waive an obligation, and current verifier evidence is still required. Missing evidence triggers at most two compact recovery rounds; exhaustion ends as `run_interrupted(completion_evidence_missing)`, never successful completion. Cancellation, protocol failures, and output truncation remain higher-priority terminal conditions. Pure chat creates no contract and adds no model round.

Tool output is treated as untrusted data. Before output is returned to the model, the sanitizer bounds its size, marks common prompt-injection patterns, redacts sensitive JSON fields, and applies shared credential redaction to plain text from shell, file, and MCP tools. Persisted RunEventLog, trace, logger, and eval-report sinks apply the same credential boundary independently.

## Reporting

Please report suspected vulnerabilities privately to the repository maintainers rather than opening a public issue. Include the affected version/commit, platform, reproduction steps, impact, and a minimal proof of concept. Do not include real API keys, private pairing tokens, or user data.

Target response times are acknowledgement within 3 business days, triage within 7 days, and a mitigation or status update within 14 days. Emergency remote-access or credential-disclosure reports are prioritized immediately.

## Release and support expectations

Production desktop releases must use the signed release configuration, trusted update metadata, checksums, SBOM, and build provenance. Unsigned development packages must not enable automatic updates. Supported versions and release evidence are recorded in the versioned release checklist.
