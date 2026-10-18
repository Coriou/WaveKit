# Rust live demodulator, phase A: tasks

- [ ] 1 Record base goldens of the csdr default path (argv, headers, status, audio bytes)
  - _Requirements: 1.1, 8.1_
- [ ] 2 Kernel `demod/` (NFM, AM, filters, AGC, NoiseMeter, gates) + proptests + SINAD tests
  - _Requirements: 2.1–2.6, 4.1, 4.2, 7.1, 7.6; Properties 1, 2, 5, 6_
- [ ] 3 TS golden-vector generator for gates and noise meter; Rust A/B tests
  - _Requirements: 4.1, 4.2, 7.3, 7.4; Properties 5, 6_
- [ ] 4 Demod channel + protocol 2 (open kind, retune, squelch, events) + process tests
  - _Requirements: 3.1–3.5, 4.3–4.6, 7.2; Properties 3, 4_
- [ ] 5 Config flag in `LiveDemodConfigSchema`, `select-engine.ts`, Zod event schemas
  - _Requirements: 1.1–1.3, 5.5; Property 7_
- [ ] 6 `rust-engine.ts` and live-demodulator wiring (retune mapping, auto floor, shutdown,
      fallback, instability) with fake-process tests
  - _Requirements: 1.2–1.5, 4.5, 5.1–5.4, 7.7_
- [ ] 7 CTCSS/DCS through the chain; A/B vs csdr reference fixtures
  - _Requirements: 4.7, 7.4, 7.5_
- [ ] 8 Bench + drop-mode harness; measurements and decoder-branch proposal in the report
  - _Requirements: 6.1, 6.2, 9.1, 9.2_
- [ ] 9 Main-seam diffs (api-types status fields, docs index/API), checks, review
  - _Requirements: 1.5_
