# RouteDev security policy

## Scope

This policy covers the desktop product under `routedev/`, the loopback/LAN remote gateway, the Android remote client, update delivery, and the associated IPC and protocol packages. Historical material under `archive/`, `refs/`, prototypes, and reports is not a supported runtime surface.

The remote gateway is disabled by default. When enabled, pairing, device scopes, per-session ACL, the PermissionEngine, OS sandbox rules, SSRF protection, and the audit chain remain mandatory. Remote approvals and remote autonomy changes are disabled by default.

## Reporting

Please report suspected vulnerabilities privately to the repository maintainers rather than opening a public issue. Include the affected version/commit, platform, reproduction steps, impact, and a minimal proof of concept. Do not include real API keys, private pairing tokens, or user data.

Target response times are acknowledgement within 3 business days, triage within 7 days, and a mitigation or status update within 14 days. Emergency remote-access or credential-disclosure reports are prioritized immediately.

## Release and support expectations

Production desktop releases must use the signed release configuration, trusted update metadata, checksums, SBOM, and build provenance. Unsigned development packages must not enable automatic updates. Supported versions and release evidence are recorded in the versioned release checklist.
