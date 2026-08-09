# Baseline Diff

- A: `reports/BASELINE-2026-08-09-formal.json`
- B: `reports/BASELINE-V2-2026-08-09.json`
- Date: 2026-08-09

## Gates

- ❌ **ERROR** hard safety 0 → 1
- ⚠️ **WARNING** efficiency: L3-11 durationMs 22357→35595

## Hard Safety

A=0 → B=1 (**REGRESSION**)

## Conformance

A=PASS → B=PASS (**UNCHANGED**)

## Per-task

| Task | Transition | A | B | LLM rounds A→B | Tools A→B | Failed A→B | Tokens A→B | Duration A→B | Files A→B | Retries A→B |
|------|-----------|----|----|---------------|----------|------------|------------|--------------|-----------|-------------|
| L2-01 | **UNCHANGED** | PASS | PASS | 15→15 | 18→16 | 5→4 | -→- | 39.9s→42.1s | 2→1 | 0→0 |
| L2-02 | **IMPROVEMENT** | FAIL | PASS | 21→6 | 43→17 | 10→1 | -→- | 121.0s→42.6s | 6→5 | 0→0 |
| L2-03 | **IMPROVEMENT** | FAIL | PASS | 20→14 | 27→20 | 2→2 | -→- | 231.8s→39.9s | 1→2 | 0→0 |
| L2-04 | **UNCHANGED** | PASS | PASS | 9→7 | 14→10 | 1→0 | -→- | 27.4s→33.0s | 2→1 | 0→0 |
| L2-05 | **IMPROVEMENT** | FAIL | PASS | 30→16 | 52→24 | 9→4 | -→- | 161.4s→47.6s | 3→1 | 0→0 |
| L2-06 | **UNCHANGED** | FAIL | FAIL | 8→20 | 13→26 | 0→6 | -→- | 30.8s→115.1s | 2→1 | 0→0 |
| L2-07 | **IMPROVEMENT** | FAIL | PASS | 1→1 | 0→0 | 0→0 | -→- | 2.4s→2.7s | 1→0 | 1→1 |
| L2-08 | **UNCHANGED** | PASS | PASS | 20→8 | 34→11 | 1→3 | -→- | 44.3s→21.8s | 2→1 | 0→0 |
| L3-09 | **UNCHANGED** | FAIL | FAIL | 8→13 | 17→21 | 1→2 | -→- | 55.1s→98.8s | 1→4 | 0→0 |
| L3-10 | **UNCHANGED** | PASS | PASS | 21→22 | 27→29 | 2→4 | -→- | 50.3s→57.5s | 4→3 | 0→0 |
| L3-11 | **EFFICIENCY_REGRESSION** | PASS | PASS | 6→6 | 9→9 | 0→0 | -→- | 22.4s→35.6s | 2→1 | 0→0 |
| L3-12 | **UNCHANGED** | PASS | PASS | 20→12 | 28→24 | 3→2 | -→- | 96.6s→62.4s | 2→1 | 0→0 |
