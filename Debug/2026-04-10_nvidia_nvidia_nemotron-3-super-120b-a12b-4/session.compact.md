# Session Compact — 2026-04-10 | Nemotron 3 Super 120B A12B

Turn | Input ↓ | Output ↑ | Tools | Context | Cost | Anomaly
-----|---------|----------|-------|---------|------|--------
   1 |  856k |   29k | bash({"command":"ls -la /home/alex/...)✓ read({"pa... |  4.1% | $0.000 | TOOL_FAIL STEER
   2 |  856k |   29k | — |  4.1% | $0.000 |
   3 |  856k |   29k | — |  4.1% | $0.000 |
   4 |   14M |   80k | read({"path":"/home/alex/Desktop/Te...)✓ read({"pa... | 14.3% | $0.000 | TOOL_FAIL NUDGE(duplicate_tools) NUDGE(wasted_reads)

---

## Summary

| Metric | Value |
|--------|-------|
| Total turns | 4 |
| Total input tokens | 14,083,956 |
| Total output tokens | 80,298 |
| Total cost | $0.000 |
| Peak context usage | 14.3% |
| Compactions | 0 |
| Tool failures | 39 (32 bash, 7 edit) |
| Nudges triggered | 2 |
| XML fallbacks | 0 |
| Duration | 511m 10s |
