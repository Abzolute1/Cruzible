# Session Compact — 2026-04-12 | Nemotron 3 Super 120B A12B

Turn | Input ↓ | Output ↑ | Tools | Context | Cost | Anomaly
-----|---------|----------|-------|---------|------|--------
   1 |  853k |   21k | — |  5.2% | $0.000 |
   2 |  1.9M |   25k | bash({"command":"ps aux | grep http...)✓ bash({"co... |  5.6% | $0.000 | TOOL_FAIL
   3 |  2.5M |   27k | bash({"command":"pwd && ls -la"})✓ bash({"command"... |  5.7% | $0.000 | TOOL_FAIL NUDGE(duplicate_tools)
   4 |  2.9M |   29k | bash({"command":"pwd && ls -la \"/h...)✓ bash({"co... |  6.0% | $0.000 | NUDGE(duplicate_tools)

---

## Summary

| Metric | Value |
|--------|-------|
| Total turns | 4 |
| Total input tokens | 2,880,795 |
| Total output tokens | 29,332 |
| Total cost | $0.000 |
| Peak context usage | 6.0% |
| Compactions | 0 |
| Tool failures | 14 (14 bash) |
| Nudges triggered | 2 |
| XML fallbacks | 0 |
| Duration | 8m 58s |
