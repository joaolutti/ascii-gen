# Preview playback performance

Playback time advances from elapsed time on `requestAnimationFrame` and publishes requests at the lower of source cadence or 30 fps. The worker processes one preview at a time and keeps only the newest pending request. Replies from the current preview generation are displayed monotonically; source replacement, seek, mode, or treatment changes invalidate older generations.

Preview rendering uses a sequential `VideoSampleSink.samples()` iterator. It retains the current and next decoded sample while playback moves forward, skips samples between requested timestamps, and restarts the iterator after a backward seek or loop. This avoids creating a new sparse decoder lookup for every preview request. MP4 export and ASCII code generation keep their independent frame-selection paths.

## Chromium measurements

Run the opt-in matrix with:

```sh
RUN_PREVIEW_PERF=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npx playwright test e2e/pixelated-performance.spec.ts --workers=1
```

The test generates local H.264 fixtures and measures three 11-second windows for each case. It reports actual canvas `ImageBitmap` draws, their interval distribution, main-thread animation-frame gaps, preview-position updates, main-thread Long Tasks, and JavaScript heap samples when the browser exposes them. Raw measurements are written to the ignored `test-results/pixelated-performance/results.json` file. Set `PREVIEW_PERF_SCENARIO` to one scenario name to rerun only that case.

The matrix ran on 2026-10-28 in headless system Chromium 155.0.8059.84 on Linux x86_64, with an Intel Core i5-10210U (4 cores / 8 threads) and 16 GB RAM. Results are medians of three windows; each window was approximately 11 seconds.

| Scenario | Source | Preview draws / second | p95 draw interval | p95 main-thread rAF gap | Long Tasks |
| --- | --- | ---: | ---: | ---: | ---: |
| Landscape, default density | 320×180, 12 fps, 2 s | 10.4 | 105.8 ms | 16.7 ms | 0 |
| Landscape, high density | 320×180, 12 fps, 2 s | 10.4 | 111.0 ms | 16.8 ms | 0 |
| Landscape, source-color mode | 320×180, 12 fps, 2 s | 10.5 | 106.4 ms | 16.7 ms | 0 |
| Portrait, default density | 180×320, 12 fps, 2 s | 10.4 | 107.5 ms | 16.7 ms | 1 total (57 ms) |
| Landscape | 320×180, 30 fps, 2 s | 22.3 | 53.3 ms | 16.8 ms | 0 |
| Near-limit source | 1920×1080, 60 fps, 14.9 s | 22.0 | 54.2 ms | 16.7 ms | 0 |

Before switching to sequential sample decoding, the near-limit case rendered 2.6 and 3.2 preview frames per second in two 11-second windows. The new median is 22.0 frames per second, about 7.5 times the prior median. This is an observed result on one Chromium machine, not a cross-device guarantee.

### Candidate tuning budgets

These are provisional Chromium-only floors for the next cross-browser run:

- 12 fps sources: median preview draw rate at least 10 fps, with p95 draw intervals at or below 120 ms.
- 30 fps sources and near-limit 60 fps sources: median preview draw rate at least 20 fps, with p95 draw intervals at or below 60 ms.
- Main-thread p95 animation-frame gap at or below 20 ms.
- No more than one main-thread Long Task over 50 ms in an 11-second window.

The measured Chromium matrix meets these candidate floors. Chrome and Edge are separate acceptance targets; neither browser is installed in this environment, so do not treat these candidates as final until the same matrix is run in both. A Chrome or Edge run can use the matching executable path in `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

Canvas draw calls measure frames painted by the app, not monitor presentation or perceived smoothness. Long Tasks and JavaScript heap samples cover the page main thread only. They do not include the worker, decoded-frame memory, GPU allocations, or total browser-process memory. The fixtures exercise maximum duration, dimensions, and cadence together; they do not approach the 100 MB file-size limit.

## Remaining validation

The supplied visual reference could not be retrieved, and no local copy is present. Pixelated reference comparison remains open. Chrome and Edge performance runs remain open. The 100 MB input-size boundary is covered by source-admission tests, but it is not a playback-performance scenario.

The media stays local as required by ADR-0001. Playback tuning does not change the selected treatment or reduce export fidelity.
