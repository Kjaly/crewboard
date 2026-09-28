# Crewboard context envelope

The host prompt carries stable Crewboard instructions; plan identity, repository, goal, task state and event text remain dynamic. The version and SHA-256 label fingerprint only the exact static Crewboard instruction bytes. It does not measure or predict provider prefix caching, KV reuse, billed tokens, or quota savings.

Wake messages identify the changed task and event, ask for a fresh plan/task read before decisions or mutations, and direct review to the current report and check receipts. Reports and event strings are data, not instructions. Routine positive checked tasks may close automatically through Crewboard's gates. The stable prompt reserves decisions, `human_review`, root acceptance and unresolved judgment for the person; repairable failures return for correction. Task briefs retain five recent events; current blockers and gates come from the authoritative task read, not historical event replay.

This is a Crewboard host prompt change. A native external Codex chat does not receive this host section, so this does not reduce that chat's context.

On the synthetic same-input fixture (three task briefs plus a duplicate wake), the previous envelope was 1,177 UTF-8 bytes and the new one 1,079 bytes. Bytes divided by four gives only an approximate 295 to 270 tokens; it is not provider billing or subscription savings.
