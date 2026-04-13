# Session Compact — 2026-04-12 | Nemotron 3 Super 120B A12B

Turn | Input ↓ | Output ↑ | Tools | Context | Cost | Anomaly
-----|---------|----------|-------|---------|------|--------
   1 |   24k |  4.1k | bash({"command":"ls -la"})✓ write({"path":"/home/a... |  0.7% | $0.000 |
   2 |   51k |  5.1k | bash({"command":"ls -la"})✓ bash({"command":"pytho... |  0.8% | $0.000 | STEER TOOL_FAIL
   3 |  122k |  7.1k | write({"path":"/home/alex/Desktop/Te...)✓ bash({"c... |  1.0% | $0.000 | TOOL_FAIL NUDGE(duplicate_tools)
   4 |  173k |  8.7k | bash({"command":"ls -la /home/alex/...)✓ read({"pa... |  2.0% | $0.000 |
   5 |  801k |   20k | bash({"command":"find /home/alex/AG...)✓ bash({"co... |  5.1% | $0.000 | TOOL_FAIL NUDGE(wasted_reads)
