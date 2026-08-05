# RouteDev license and repository boundaries

- `routedev/` is the AGPL-3.0 product source and runtime.
- `routedev-android/` is the Android client/protocol project; its declared license and third-party notices travel with Android artifacts.
- `archive/` contains historical or retired scaffolding and is not a supported runtime dependency.
- `refs/` contains read-only external reference material and must not be copied into product releases without checking its license.
- `报告/`, design prototypes, and phase documents are project records, not runtime dependencies.

Every release review must confirm that generated artifacts contain only product code, declared dependencies, licenses/notices, and approved assets. New external code or assets require a license review before merge.
