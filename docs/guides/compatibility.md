# Compatibility policy

- **Claude Code**: ≥ 2.1.259 (`--permission-prompts`). Developed and tested against 2.1.308. Only documented flags are used.
- **Node**: ≥ 22.13 for the engine (`node:sqlite`, which still prints an ExperimentalWarning that `bin/proofloop` silences). Code Mode additionally needs ≥ 25. CI covers 22 and 24 for the engine and 25 for the sandbox.
- **OS**: macOS and Linux. Windows is untested and unsupported.
- **Protocols** carry `schemaVersion` and a minimum `engine`. Within a minor line, built-in protocol ids and gate ids are stable; removals need a major version. A run pins the protocol id, version and content hash (`protocol.pinned` event) and prints it in its report.
- **State database**: migrations are forward-only via `PRAGMA user_version`. Downgrading after a migration is unsupported; back up `.proofloop/state.db` first.
- **GitHub**: sub-issues and blocked-by use GraphQL mutations; when a host does not support them ProofLoop reports `unsupported` and keeps the dependency in the issue text.
