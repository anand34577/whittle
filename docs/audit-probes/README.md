# Audit probes

Throwaway scripts used during the October 2026 audit to measure behaviour that is still open
(see AUDIT_REPORT.md). They are not part of the test suite. To run one, copy it into
`packages/kernel/test/` as `<name>.test.ts` and run:

    node node_modules/vitest/vitest.mjs run packages/kernel/test/<name>.test.ts --reporter=verbose --disable-console-intercept

| File | What it shows |
|---|---|
| core-and-refs.probe.ts | P1 a face reference silently re-binds to an unrelated face (open, A-03); P3 cache-key growth (fixed); P7 solver with absurd values; P9 lying zip sizes (safe) |
| validity-and-scale.probe.ts | Q3 validity of odd geometry; Q4 sketch with 200/600 circles (open, J-01); Q5 1,500-feature timeline |
| sketch-fuse-cost.probe.ts | Q4b where the sketch time goes: sequential vs balanced 2D fuse |
| solver-and-propagation.probe.ts | solver states (under/full/over/redundant) and error propagation |
| export-roundtrip.probe.ts | STEP/STL round trip and 3MF/GLB/OBJ/PLY/STL structure checks |

The probes that ran against since-fixed behaviour (bow-tie extrusion, damaged import, parameter rename)
now live as regression tests in `packages/kernel/test/audit2.test.ts` and `packages/core/test/audit2.test.ts`.
