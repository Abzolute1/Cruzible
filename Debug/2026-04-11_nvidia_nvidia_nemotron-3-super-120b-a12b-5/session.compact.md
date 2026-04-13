# Session Compact — 2026-04-11 | Nemotron 3 Super 120B A12B

Turn | Input ↓ | Output ↑ | Tools | Context | Cost | Anomaly
-----|---------|----------|-------|---------|------|--------
   1 |   13M |   81k | bash({"command":"ls -la"})✓ read({"path":"/home/al... | 12.8% | $0.000 | TOOL_FAIL NUDGE(duplicate_tools)

---

## Summary

| Metric | Value |
|--------|-------|
| Total turns | 1 |
| Total input tokens | 13,189,032 |
| Total output tokens | 80,975 |
| Total cost | $0.000 |
| Peak context usage | 12.8% |
| Compactions | 0 |
| Tool failures | 27 (23 bash, 4 edit) |
| Nudges triggered | 1 |
| XML fallbacks | 0 |
| Duration | 74m 3s |
