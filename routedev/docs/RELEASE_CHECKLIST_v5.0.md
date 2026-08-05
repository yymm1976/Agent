# RouteDev v5.0 release checklist

This checklist is additive to `RELEASE_CHECKLIST_v4.9.md`; historical results are preserved.

## Blocking checks

- [ ] `pnpm install --frozen-lockfile` succeeds on a clean runner.
- [ ] Core and desktop typechecks pass.
- [ ] Full Vitest, remote ACL, IPC, PermissionEngine, SSRF, SecretStore, and updater tests pass.
- [ ] Windows, macOS, Linux Electron builds pass; Windows/macOS have signing and notarization evidence.
- [ ] Android unit tests, lint, and clean debug/release build pass.
- [ ] Default autonomy is `manual`; remote gateway is disabled; remote approval/autonomy scopes remain disabled unless explicitly enabled locally.
- [ ] Update metadata is trusted, downloaded package checksum matches, and signed update verification succeeds. Unsigned packages cannot initialize automatic updates.
- [ ] Release assets include SHA-256 checksums, SBOM, and SLSA/GitHub provenance attestation.
- [ ] No API keys, certificates, vault contents, or pairing tokens are present in the repository or release artifacts.

## Operational evidence

- [ ] Record CI run URLs, commit, platform matrix, test counts, coverage baseline, and known environment blocks.
- [ ] Record rollback version and the update failure diagnostic path.
- [ ] Review `SECURITY.md`, data-flow retention, and license-boundary documents before publishing.
