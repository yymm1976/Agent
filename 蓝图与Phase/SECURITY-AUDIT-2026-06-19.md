# RouteDev Deep Security Audit Report

**Date**: 2026-06-19  
**Scope**: 11 subsystems across ~70+ source files  
**Auditor**: Automated deep audit  

---

## Critical — Security Vulnerabilities

---

### C1: File tools lack internal path boundary validation
**Files**: `src/tools/builtin/file-read.ts:57`, `src/tools/builtin/file-write.ts:53`, `src/tools/builtin/file-edit.ts`, `src/tools/builtin/list-directory.ts`

**Description**: All file operation tools resolve paths with `path.resolve(context.workingDirectory, args.path)` but perform NO internal boundary check. They rely entirely on `executor.ts:isFileOperation()` calling `securityChecker.checkFilePath()`. If executor security is bypassed (e.g., direct tool invocation via plugin bridge, or middleware short-circuit), any file on the filesystem can be read/written/edited. Contrast with `code-search.ts:64-76` which HAS its own `allowedDirs` boundary check.

**Code snippet** (file-read.ts:57):
```typescript
const fullPath = path.resolve(context.workingDirectory, args.path as string);
// No boundary check - directly reads the file
const content = await fs.readFile(fullPath, 'utf-8');
```

**Impact**: Path traversal attack can read/write arbitrary files (e.g., `../../etc/passwd`, `C:\Windows\System32\config\SAM`). Defense-in-depth principle violated.

**Fix**: Add `allowedDirs` boundary check inside each tool (matching code-search.ts pattern), not just in executor.ts.

---

### C2: web_search tool has no SSRF protection and no response size limit
**File**: `src/tools/builtin/web-search.ts:100`

**Description**: Unlike `web-fetch.ts:79` which calls `checkSSRF()`, the `web_search` tool fetches DuckDuckGo HTML results without any SSRF check. Additionally, the internal `fetchUrl` function accumulates response data without limit (`data += chunk.toString('utf-8')`), enabling memory exhaustion. Furthermore, `executor.ts:isNetworkOperation` checks `'url' in args` but web_search's parameter is `query`, not `url`, so the executor-level SSRF check never triggers for this tool.

**Code snippet** (web-search.ts ~line 100):
```typescript
function fetchUrl(url: string): Promise<string> {
  // ...
  res.on('data', (chunk: Buffer) => {
    data += chunk.toString('utf-8'); // Unbounded accumulation
  });
}
```

**Impact**: (1) SSRF: DuckDuckGo result links are fetched without private IP validation. (2) DoS: A malicious or very large response can exhaust Node.js heap memory.

**Fix**: Add `checkSSRF()` before fetching; add response size cap (e.g., 256KB matching web-fetch).

---

### C3: Permission engine auto-approves file_write/file_edit, contradicting requiresApproval
**File**: `src/tools/permission-engine.ts` (DEFAULT_AUTO_RULES)

**Description**: The default permission rules include `auto-file-wildcard` with pattern `file_*` that auto-approves ALL file-prefixed tools. This silently overrides the `requiresApproval: true` declaration on `file_write` and `file_edit`. The permission engine's 3-layer priority (deny > confirm > auto) means auto rules take precedence over confirm rules.

**Code snippet**:
```typescript
// In DEFAULT_AUTO_RULES:
{ id: 'auto-file-wildcard', pattern: 'file_*', /* auto-approves file_write, file_edit */ }
```

**Impact**: Destructive file operations (write, edit) execute without user confirmation, violating the principle of least privilege. An LLM hallucinating a file path could silently overwrite critical files.

**Fix**: Change `auto-file-wildcard` pattern to only match read-only tools (`file_read`, `file_search`), or split into explicit rules per tool.

---

### C4: MCP child processes inherit full process.env (all secrets exposed)
**File**: `src/tools/mcp/client.ts:185`

**Description**: When spawning MCP server child processes, the full `process.env` is spread into the child environment, then overlaid with MCP-specific env vars. This exposes ALL environment variables including API keys, database credentials, and other secrets to untrusted MCP server processes. Compare with `shell-exec.ts` which uses an `ALLOWED_ENV_KEYS` whitelist.

**Code snippet** (client.ts:185):
```typescript
env: { ...process.env, ...entry.config.env }
// vs shell-exec.ts which does:
// env: filterByWhitelist(process.env, ALLOWED_ENV_KEYS)
```

**Impact**: Any MCP server (including third-party) receives all process secrets. A malicious MCP server can exfiltrate API keys, database passwords, etc.

**Fix**: Apply the same `ALLOWED_ENV_KEYS` whitelist used by shell-exec, or define a separate MCP-specific env whitelist.

---

### C5: Plugin system has zero isolation — full Node.js capability
**File**: `src/plugins/registry.ts:5-7` (explicit comment), dynamic `await import()`

**Description**: The plugin registry explicitly acknowledges (in source comments) that plugins have NO sandbox, NO signature verification, and NO permission declaration. Plugins are loaded via dynamic `import()` with full Node.js capability. A malicious or compromised plugin can read/write any file, execute commands, exfiltrate data.

**Impact**: Full system compromise through malicious plugin. No containment boundary.

**Fix**: Implement at minimum: (1) plugin permission declaration in manifest, (2) restricted API surface for plugins (proxy pattern), (3) consider vm.isolate or worker_threads with restricted access for untrusted plugins.

---

### C6: Permission engine deny rules miss all Windows system paths
**File**: `src/tools/permission-engine.ts` (deny rules)

**Description**: Deny rules only check Unix absolute paths (`/etc/`, `/proc/`, `/sys/`, `/dev/`, `/boot/`, `/root/`). On Windows, system directories like `C:\Windows`, `C:\Program Files`, `C:\Users\*\AppData\Local\Microsoft` are completely unprotected. Given RouteDev is a Windows-first CLI tool (based on the project's APPDATA path usage), this is a significant gap.

**Impact**: `rm -rf C:\Windows` or `del /s C:\Program Files` would NOT be blocked by deny rules.

**Fix**: Add Windows-specific deny patterns: `C:\\Windows`, `C:\\Program Files`, `C:\\ProgramData`, `%SYSTEMROOT%`.

---

## Important — Bugs and Logic Errors

---

### I1: command-parser.ts cannot handle command chaining (&&, ||, ;)
**File**: `src/tools/command-parser.ts`

**Description**: The tokenizer only extracts the first command. Compound commands like `echo safe && rm -rf /` parse as `echo`, bypassing all security checks on `rm -rf /`. The parser does not split on `&&`, `||`, or `;`.

**Impact**: Security check bypass through command chaining. Attacker (or hallucinating LLM) can hide dangerous commands after a safe-looking prefix.

**Fix**: Split input on `&&`, `||`, `;`, `|` before tokenizing; check each sub-command independently.

---

### I2: security-enhanced.ts Layer 4 regex patterns are bypassable
**File**: `src/tools/security-enhanced.ts`

**Description**: Multiple dangerous-pattern regexes have bypass gaps:
- `rm` pattern: `rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$` does NOT match `rm -rf /*` or `rm -rf / --no-preserve-root`
- `dd` pattern: `\bdd\s+.*of=\/dev\/` does NOT match `dd bs=4M if=/dev/zero of=/dev/sda` (when `of=` appears after other args, the `.*` may not span correctly)
- `mkfs`/`fdisk` patterns are too specific

**Impact**: Destructive shell commands can evade Layer 4 detection with minor reformulation.

**Fix**: Use more permissive regex or switch to token-based argument analysis (e.g., check if any arg starts with `/` for `rm -f`, check if `of=` targets a device path regardless of position).

---

### I3: trust-gradient.ts hashArgs uses collision-prone 32-bit hash
**File**: `src/tools/trust-gradient.ts` (hashArgs function)

**Description**: `hashArgs` uses djb2 hash with `hash |= 0` (32-bit truncation). With only ~4 billion possible values, birthday paradox collisions become likely after ~77,000 grants. Different tool arguments producing the same hash would grant unintended temporary permissions.

**Impact**: Permission leak through hash collision: tool A gets temporary grant for args X, tool B with different args Y (same hash) inherits the grant.

**Fix**: Use `crypto.createHash('sha256')` for argument hashing, or at minimum use a 64-bit hash.

---

### I4: scheduler/store.ts TOCTOU race condition
**File**: `src/scheduler/store.ts`

**Description**: Every store operation follows the pattern: load from disk -> modify in memory -> save to disk. Two concurrent operations (e.g., task trigger + task update) can interleave, causing lost updates. The atomic write (write .tmp + rename) prevents corruption but not lost updates.

**Impact**: In multi-task scenarios, schedule state changes (nextRun, runCount) can be silently lost.

**Fix**: Implement an in-memory write-through cache with single-writer pattern, or use file locking.

---

### I5: search-utils.ts matchGlob creates regex without escaping special characters
**File**: `src/tools/builtin/search-utils.ts` (matchGlob function)

**Description**: `matchGlob` only escapes `.` and converts `*`/`?` to regex equivalents. Other regex special characters (`[`, `]`, `(`, `)`, `+`, `{`, `}`, `^`, `$`, `|`, `\`) pass through unescaped. Input like `[a-z]+.ts` would be interpreted as a regex character class.

**Impact**: Glob pattern injection can cause unexpected file matching or ReDoS (if crafted regex causes catastrophic backtracking).

**Fix**: Escape all regex special characters before glob-to-regex conversion.

---

### I6: security-enhanced.ts filterSensitiveFields is overly aggressive
**File**: `src/tools/security-enhanced.ts` (filterSensitiveFields)

**Description**: The regex `/(?:sk-|pk-|rk-)?[a-zA-Z0-9]{32,}/g` matches any alphanumeric string of 32+ characters, with optional prefixes. This redacts: base64-encoded data, hex strings, long identifiers, hash values, UUIDs (without dashes), and even natural text that happens to be alphanumeric and 32+ chars.

**Impact**: False positive redaction corrupts legitimate tool output, potentially hiding important data (file hashes, encoded content, etc.).

**Fix**: Require at least one prefix (sk-/pk-/rk-) OR use entropy-based detection. Consider only redacting when the string has high Shannon entropy (>4.5 bits/char).

---

### I7: Permission engine deny rules only check first token from parseCommand
**File**: `src/tools/permission-engine.ts`

**Description**: Deny rules use `parseCommand` to tokenize, but the deny matching checks the command name and arguments as a joined string. Complex commands with subshells (`bash -c "rm -rf /"`) or environment variable expansion (`CMD=rm; $CMD -rf /`) bypass tokenization.

**Impact**: Deny rules can be evaded through subshell invocation or variable expansion.

**Fix**: Also check the raw command string against deny patterns, not just tokenized form.

---

### I8: message-router.ts userContexts map is unbounded
**File**: `src/channels/message-router.ts:40`

**Description**: The `userContexts` Map grows with each unique user (keyed by `channelType:senderId`). Cleanup runs every 10 minutes via `cleanupExpiredContexts()` but there's no hard cap. A flood of unique senders (e.g., in a large Slack workspace) can exhaust memory.

**Impact**: Memory exhaustion DoS in channel mode.

**Fix**: Add a max cap (e.g., 10000 entries), evicting oldest entries when exceeded (LRU pattern).

---

### I9: spawnAgent closure captures mutable spawnDepth without concurrency protection
**File**: `src/cli/app-init.ts:310-386`

**Description**: `spawnDepth` is a module-level `let` variable incremented/decremented around child agent execution. If multiple spawn_agent calls execute concurrently (possible with parallel tool execution enabled at line 349), the counter is shared and can underflow or allow exceeding the depth limit.

**Impact**: Concurrent sub-agents can bypass the recursion depth limit or cause the counter to go negative.

**Fix**: Pass depth as a parameter through the spawn chain rather than using a shared mutable variable.

---

## Minor — Code Quality Issues

---

### M1: registry.ts silently overwrites on duplicate registration
**File**: `src/tools/registry.ts`

**Description**: `register()` warns on duplicate names but still overwrites the existing tool. No way to detect accidental overwrites at runtime.

**Fix**: Add a `forceOverwrite` parameter, or throw on duplicate by default.

---

### M2: repo-map.ts buildRepoMap has no path boundary validation
**File**: `src/tools/repo-map.ts:120`

**Description**: `buildRepoMap` accepts any `root` path and recursively scans it without validation. While typically called with the project root, no check prevents scanning sensitive directories.

**Fix**: Add path boundary check similar to code-search.ts.

---

### M3: prompt manager loadFromFile doesn't validate template ID for path traversal
**File**: `src/prompts/manager.ts:620-643`

**Description**: `loadFromFile` constructs `path.join(dir, `${id}.md`)` without validating that `id` doesn't contain `../` sequences. While template IDs are typically code-defined, project-level overrides accept any ID.

**Fix**: Validate that template ID matches `^[a-zA-Z0-9._-]+$` before constructing the file path.

---

### M4: logger initializes at module load time with side effects
**File**: `src/utils/logger.ts:13-14`

**Description**: `const LOG_DIR = join(getAppDataDir(), 'logs'); ensureDir(LOG_DIR);` runs at import time. This creates directories on the filesystem as a side effect of importing the module, which can cause issues in testing or when the module is imported in unexpected contexts.

**Fix**: Lazy-initialize the logger (factory function called explicitly).

---

### M5: stall-detector timer doesn't call .unref()
**File**: `src/utils/stall-detector.ts:41`

**Description**: `setInterval` in `start()` doesn't call `.unref()`, preventing the Node.js process from exiting naturally when all other work is done.

**Fix**: Add `.unref()` to the interval timer.

---

### M6: todo-store.ts counter-based ID not collision-safe across instances
**File**: `src/tools/builtin/todo-store.ts:40-43`

**Description**: `nextId()` uses a simple incrementing counter (`todo-${this.counter}`). If two TodoStore instances exist (e.g., in tests or sub-agents), IDs will collide.

**Fix**: Use `crypto.randomUUID()` or prefix with a store-specific namespace.

---

### M7: chat-runner.ts detectProjectContext uses spawnSync synchronously
**File**: `src/cli/chat-runner.ts:56`

**Description**: `spawnSync('git', ['status', '--porcelain'])` blocks the event loop. While the 3s timeout limits worst-case impact, this runs on every user message.

**Fix**: Use `spawn` (async) or cache the result with a TTL.

---

## Info — Improvement Suggestions

---

### F1: Consider implementing a security audit trail for tool executions
All tool executions should be logged with: tool name, arguments hash, security check results (pass/fail), execution duration. Currently only failures are logged via `logger.warn`.

---

### F2: Consider rate limiting for tool executions
No per-tool rate limiting exists. A runaway agent loop could execute thousands of file operations per second. Consider token-bucket rate limiting per tool category.

---

### F3: Consider implementing command allowlists per autonomy mode
Currently, autonomy modes (plan/build/compose) control confirmation requirements but don't restrict which commands can be executed. A `plan` mode agent could still execute shell commands if approved.

---

### F4: Add integrity verification for plugin state files
`plugin-state.json` is written without integrity protection. A malicious actor with filesystem access could modify plugin enable/disable state.

---

### F5: Consider encrypting sensitive config values at rest
API keys in YAML config are stored in plaintext. Consider supporting encrypted values with a local key derivation.

---

## Security Score: 6.0 / 10

**Scoring rationale**:
- Strong points: SSRF protection in web-fetch, 7-layer bash security, timing-safe webhook signatures, result sanitizer with injection detection, read-before-write enforcement, comprehensive channel adapter security (Slack/WeChat/Telegram all properly verified)
- Critical gaps: Missing defense-in-depth in file tools (C1), missing SSRF in web-search (C2), permission auto-rule contradiction (C3), MCP env leak (C4), plugin sandbox absence (C5), Windows path blind spot (C6)
- The security architecture is fundamentally sound in design (layered checks, permission engine, trust gradient), but has implementation gaps that undermine the layered defense

---

## Top 5 Priority Fixes

| Priority | ID | Issue | Effort | Impact |
|----------|----|-------|--------|--------|
| **1** | C3 | Permission engine auto-approves file_write/file_edit | Low (config change) | Eliminates silent destructive file operations |
| **2** | C1 | Add path boundary checks inside file tools (defense-in-depth) | Medium | Prevents path traversal even if executor security is bypassed |
| **3** | C4 | MCP child process env whitelist | Low | Prevents secret exfiltration through MCP servers |
| **4** | C2 | Add SSRF check + response size limit to web_search | Low | Closes SSRF gap and DoS vector |
| **5** | C6 | Add Windows system path deny rules | Low | Critical for a Windows-first CLI tool |

**Honorable mentions**: I1 (command chaining bypass) should be fixed alongside C6 as both address shell security gaps. I3 (hash collision) should be addressed before the system sees high-volume production use.

---

## Audit Coverage Summary

| Subsystem | Files Audited | Findings |
|-----------|--------------|----------|
| Tools (builtin) | 14 files | C1, C2, C3, I5, M2, M6, M7 |
| Tools (core) | 7 files | I3, I6, I7, M1 |
| Tools (MCP) | 3 files | C4 |
| Config | 3 files | - |
| Plugins | 3 files | C5, F4 |
| Scheduler | 3 files | I4 |
| Hooks | 1 file | - |
| CLI Infrastructure | 6 files | I9, M4, M7 |
| Utils | 5 files | M5, F1 |
| Observability | 2 files | - |
| Prompts | 2 files | M3 |
| Channels | 5 files | I8, F2 |
| Memory | 1 file | - |
| **Total** | **~55 files** | **6C + 9I + 7M + 5F = 27 findings** |
