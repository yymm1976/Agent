# RouteDev data flow and retention

| Source | Processing boundary | Durable destinations | Default handling |
|---|---|---|---|
| User messages and files | ChatBridge, PermissionEngine, tool adapters | Session history, checkpoints, trace/audit when enabled | Keep only for the configured project/session retention period |
| Provider/MCP requests | Provider client or MCP transport | Usage counters and redacted trace metadata | Never persist provider secrets in YAML or logs |
| Tool output | Sanitizer, content router, concise-thinking/offload | Model context and optional local offload file | Sanitizer failure withholds raw output; offload paths stay inside the project data boundary |
| Remote device actions | Gateway authentication, pairing scopes, session ACL | Event journal and audit chain | Include device/session/turn/scope/result; revoke access closes active event streams |
| Secrets | SecretStore backed by Electron `safeStorage` | Encrypted sidecar only | Environment references remain compatible; exports and diagnostics are redacted |
| Memory and profile signals | Memory/skill lifecycle | Local profile and hit statistics | No provider upload unless a separately configured feature explicitly sends it |

The retention period is configuration-driven. A diagnostic bundle must be treated as sensitive and must pass the same redaction rules as logs and config exports.
