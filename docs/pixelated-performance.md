# Preview playback performance

Playback time advances from elapsed time on `requestAnimationFrame` and publishes requests at the lower of source cadence or 30 fps. The worker processes one preview at a time and keeps only the newest pending request. Replies from the current preview generation are displayed monotonically; source replacement, seek, mode, or treatment changes invalidate older generations.

Preview rendering uses a sequential `VideoSampleSink.samples()` iterator. It retains the current and next decoded sample while playback moves forward, skips samples between requested timestamps, and restarts the iterator after a backward seek or loop. This avoids creating a new sparse decoder lookup for every preview request. MP4 export and ASCII code generation keep their independent frame-selection paths.

## Chromium measurements

Run the opt-in matrix with:

```sh
RUN_PREVIEW_PERF=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npx playwright test e2e/pixelated-performance.spec.ts --workers=1
```

The test generates local H.264 fixtures and measures three 11-second windows for each case. Every scenario also gets 20 seek and 20 treatment-change latency samples. It reports canvas `ImageBitmap` draws and intervals, main-thread animation-frame gaps, request-to-reply and request-to-presentation latency, worker sample lookup/decode, frame rendering and bitmap creation time, queue counters, preview-position updates, main-thread Long Tasks, and JavaScript heap samples when the browser exposes them. A three-window control run disables app and worker diagnostics to estimate instrumentation overhead. Raw measurements are written to the ignored `test-results/pixelated-performance/results.json` file. Set `PREVIEW_PERF_SCENARIO` to one scenario name to rerun only that case.

The matrix ran on 2026-10-28 in headless system Chromium 155.0.8059.84 on Linux x86_64, with an Intel Core i5-10210U (4 cores / 8 threads) and 16 GB RAM. Results are medians of three windows; each window was approximately 11 seconds.

| Scenario | Source / treatment | Preview draws / second | p95 draw interval | p95 worker time | p95 seek / appearance |
| --- | --- | ---: | ---: | ---: | ---: |
| Landscape, low density | 320×180, 12 fps, 24 columns, grayscale | 10.5 | 103.8 ms | 3.7 ms | 23 / 33 ms |
| Landscape, default density | 320×180, 12 fps, 88 columns, grayscale | 10.5 | 106.3 ms | 11.4 ms | 27 / 39 ms |
| Landscape, high density | 320×180, 12 fps, 160 columns, grayscale | 10.4 | 105.6 ms | 25.8 ms | 72 / 57 ms |
| Landscape, source color | 320×180, 12 fps, 88 columns, color | 10.4 | 106.1 ms | 14.1 ms | 55 / 72 ms |
| Portrait, default density | 180×320, 12 fps, 88 columns, grayscale | 10.5 | 110.5 ms | 55.3 ms | 56 / 57 ms |
| Landscape, fractional rate | 320×180, 23.976 fps, 88 columns, grayscale | 20.1 | 56.1 ms | 16.7 ms | 43 / 38 ms |
| Landscape, 30 fps | 320×180, 30 fps, 88 columns, grayscale | 22.1 | 56.5 ms | 11.6 ms | 34 / 26 ms |
| Landscape, 60 fps | 320×180, 60 fps, 88 columns, grayscale | 22.1 | 53.9 ms | 9.4 ms | 77 / 62 ms |
| Near-limit source | 1920×1080, 60 fps, 14.9 s, 88 columns, grayscale | 22.3 | 55.0 ms | 24.8 ms | 728 / 41 ms |

Table values are medians across the three windows; interaction values are medians of the per-window p95s from 20 samples each. The main-thread rAF p95 was 16.7–16.8 ms in all scenarios. No Long Tasks were observed in this run. The main-thread heap peak median was 44.4 MiB or lower per scenario; it excludes decoded-frame, worker, GPU, and browser-process allocations. Worker p95 is the sum of measured sample lookup/decode, ASCII rendering and bitmap creation, and does not include browser display scheduling.

The preview queue stayed within one in-flight worker render and one replaceable pending request. No stale replies or pending-request replacements occurred during these steady playback windows. This does not measure bursts from rapid source/treatment changes; replacement and disposal behavior are covered by the functional lifecycle checks.

Diagnostic instrumentation changed the default landscape draw rate by about 1% (10.5 fps instrumented versus 10.4 fps in the control). The canvas draw wrapper itself used 0.8–1.1 ms across the control windows. This control isolates the extra app/worker diagnostics while leaving the canvas hook enabled in both runs.

Before switching to sequential sample decoding, the near-limit case rendered 2.6 and 3.2 preview frames per second in two 11-second windows. The new median is 22.0 frames per second, about 7.5 times the prior median. This is an observed result on one Chromium machine, not a cross-device guarantee.

### Baseline budgets and hypothesis evaluation

The provisional hypotheses in #31 are evaluated against this matrix before tuning. They are target budgets, not a claim that the measured baseline passes:

- **Displayed cadence:** at least 90% of `min(source fps, 30)` in each supported configuration. The baseline misses this at all rates: 12 fps scenarios reach 87–88%; 23.976 fps reaches 84%; 30 and 60 fps reach 74% of the 30 fps cap. This hypothesis remains a release target for #13.
- **Displayed-frame gaps:** p95 no greater than 1.5 times the target interval (the target interval is `1 / min(source fps, 30)`). This passes at 12 and 23.976 fps, but the 30/60 fps runs measure 54–57 ms against a 50 ms budget. This remains a #13 target.
- **Seek latency:** p95 no greater than 150 ms. Ordinary preview sizes pass (23–77 ms); the near-limit 1080p source misses at 728 ms. Keep the 150 ms target and report the near-limit miss until tuning evidence supports a revision.
- **Treatment-appearance latency:** p95 no greater than 250 ms. All measured configurations pass (26–72 ms).
- **Page JavaScript heap:** peak below 64 MiB in each 11-second window. All measured medians pass, with the highest scenario median at 44.4 MiB. This is only the page heap, not decoded media, worker, GPU, or total process memory; no total-resource budget can be assessed from this browser instrumentation.
- **Bounded work:** at most one in-flight worker render plus one replaceable pending request; stale-generation replies must never be displayed. The steady playback windows observed no stale replies or pending replacements. Existing replacement/disposal lifecycle checks cover rapid invalidation behavior; these counters do not quantify its peak memory.
- **Main thread:** rAF p95 at or below 20 ms and no more than one Long Task over 50 ms per 11-second window. The observed 16.7–16.8 ms rAF p95 and zero Long Tasks pass.

The priority for #13 is to address frame rendering and bitmap creation first: sample lookup/decode stayed small, while these stages account for most worker time at high density, portrait, and 1080p. The 1080p seek outlier also needs investigation. This measured Chromium baseline does not establish feasibility on the supported desktop browser set. Chrome and Edge are separate acceptance targets; neither browser is installed in this environment, so #31 remains incomplete until the matrix is repeated in both. A Chrome or Edge run can use the matching executable path in `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

### Post-change comparison for #13

Commit `1f06126` is the measured baseline. The current change reuses a bounded sampling canvas and avoids redundant canvas fill-style writes. The same Chromium matrix and instrumentation ran on the same machine; values below are medians across three windows. The change leaves Density, mapping, colors, and output cadence intact.

| Scenario | Draws/s, before → after | Worker p95, before → after | Seek p95, before → after |
| --- | ---: | ---: | ---: |
| Landscape, low density | 10.5 → 10.4 | 3.7 → 3.5 ms | 23 → 23 ms |
| Landscape, default density | 10.5 → 10.5 | 11.4 → 13.6 ms | 27 → 36 ms |
| Landscape, high density | 10.4 → 10.5 | 25.8 → 25.3 ms | 72 → 103 ms |
| Landscape, source color | 10.4 → 10.4 | 14.1 → 9.9 ms | 55 → 38 ms |
| Portrait, default density | 10.5 → 10.4 | 55.3 → 24.9 ms | 56 → 42 ms |
| Landscape, fractional rate | 20.1 → 20.1 | 16.7 → 11.2 ms | 43 → 39 ms |
| Landscape, 30 fps | 22.1 → 22.2 | 11.6 → 9.1 ms | 34 → 39 ms |
| Landscape, 60 fps | 22.1 → 22.2 | 9.4 → 10.6 ms | 77 → 34 ms |
| Near-limit source | 22.3 → 22.3 | 24.8 → 24.2 ms | 728 → 689 ms |

Appearance p95 stayed between 24 and 110 ms after the change. Draw cadence is effectively unchanged, and several worker and seek measurements vary slightly between runs; the clearest improvement is portrait worker p95, down from 55.3 ms to 24.9 ms. The 90% cadence hypothesis and 150 ms near-limit seek budget still fail. Keep #13 open for the remaining cadence and near-limit seek diagnosis; this change does not justify weakening those targets.

One of the 27 full-matrix windows recorded four Long Tasks during the first low-density run; the other two windows had none. An isolated repeat of that same scenario recorded none across all three windows. Keep the transient in the raw run and treat the isolated repeat as evidence that it did not recur, rather than removing the first observation.

Canvas draw calls measure frames painted by the app, not monitor presentation or perceived smoothness. Long Tasks and JavaScript heap samples cover the page main thread only. They do not include the worker, decoded-frame memory, GPU allocations, or total browser-process memory. The fixtures exercise maximum duration, dimensions, and cadence together; they do not approach the 100 MB file-size limit. The matrix combines source-color mode with default density only; it does not test every density/color combination.

## Remaining validation

An October 23 screen recording of the inspiration post linked in the [product spec](product-spec.md) is available locally and shows its animated gold Pixelated fish treatment. A side-by-side comparison against the ticket's exact acceptance criteria remains open. Chrome and Edge performance runs also remain open because neither browser is installed in this environment. The 100 MB input-size boundary is covered by source-admission tests, but it is not a playback-performance scenario.

The media stays local as required by ADR-0001. Playback tuning does not change the selected treatment or reduce export fidelity.
