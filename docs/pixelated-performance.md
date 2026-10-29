# Preview playback performance

Playback time advances from elapsed time on `requestAnimationFrame` and publishes requests at the lower of source cadence or 30 fps. The worker processes one preview at a time and keeps only the newest pending request. Replies from the current preview generation are displayed monotonically; source replacement, seek, mode, or treatment changes invalidate older generations.

Preview rendering uses a sequential `VideoSampleSink.samples()` iterator. It retains the current and next decoded sample while playback moves forward, skips samples between requested timestamps, and restarts the iterator after a backward seek or loop. This avoids creating a new sparse decoder lookup for every preview request. MP4 export and ASCII code generation keep their independent frame-selection paths.

## Chromium measurements

Run the opt-in matrix with:

```sh
RUN_PREVIEW_PERF=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npx playwright test e2e/pixelated-performance.spec.ts --workers=1
```

The test generates local H.264 fixtures and measures three 11-second windows for each case. Every scenario also gets 20 seek and 20 treatment-change latency samples. It reports canvas `ImageBitmap` draws and intervals, main-thread animation-frame gaps, request-to-reply and request-to-presentation latency, worker sample lookup/decode, frame rendering and bitmap creation time, queue counters, preview-position updates, main-thread Long Tasks, and JavaScript heap samples when the browser exposes them. A three-window control run disables app and worker diagnostics to estimate instrumentation overhead. Raw measurements are written to the ignored `test-results/pixelated-performance/results.json` file. Set `PREVIEW_PERF_SCENARIO` to one scenario name or a comma-separated list to rerun a subset. Pixelated-specific cases cover default and finest Grid step in portrait and landscape at 12 fps.

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

### Pixelated measurements and reference review for #26

The same Chromium build, machine, fixture cadence, diagnostics, and three 11-second windows were used for four Pixelated scenarios through the public editor. Each scenario also collected 20 seek and 20 Brightness-change samples. The local 12 fps, 2-second fixtures cover landscape and portrait at the default 8 px Grid step and finest 4 px Grid step.

| Scenario | Preview draws / second | p95 draw interval | p95 worker time | p95 seek / appearance | Peak page heap median |
| --- | ---: | ---: | ---: | ---: | ---: |
| Landscape, default 8 px | 10.4 | 102.7 ms | 4.5 ms | 25 / 40 ms | 12.2 MiB |
| Landscape, finest 4 px | 10.5 | 103.1 ms | 7.6 ms | 35 / 49 ms | 22.1 MiB |
| Portrait, default 8 px | 10.5 | 102.8 ms | 4.8 ms | 24 / 24 ms | 15.1 MiB |
| Portrait, finest 4 px | 10.5 | 102.6 ms | 7.4 ms | 29 / 25 ms | 20.5 MiB |

All four configurations have 16.7–16.8 ms main-thread rAF p95, no Long Tasks, no stale replies, and no queue replacements. This pre-highlight baseline had worker time well below the 12 fps frame interval. Actual displayed cadence was still about 87% of the 12 fps source, below the 90% hypothesis used for #13.

The October 23 reference recording (`/home/jl/Videos/screenrecording-2026-10-23_17-39-02.mp4`) shows gold fish on black, regular square cells, recognizable silhouettes, internal tonal variation, and bright glow-like speckles. A local fish source was rendered through Pixelated mode (`/home/jl/Downloads/173684-849839047_tiny_trimmed.mp4`); its different composition prevents an exact motion/silhouette comparison, but the output preserves regular gold cells, visible fish silhouettes, and cell-level tonal detail. With the user's approval, the brightest cells now have soft gold halos and pale core highlights. Dithering and tonal-mapping changes were not introduced.

After the highlight change, the same four cases produced:

| Scenario | Draws/s, before → after | p95 worker, before → after | p95 draw gap, before → after | p95 seek / appearance after | Peak page heap after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Landscape, default 8 px | 10.4 → 10.5 | 4.5 → 4.6 ms | 102.7 → 102.2 ms | 26 / 26 ms | 12.2 MiB |
| Landscape, finest 4 px | 10.5 → 10.4 | 7.6 → 8.1 ms | 103.1 → 102.3 ms | 28 / 43 ms | 12.6 MiB |
| Portrait, default 8 px | 10.5 → 10.5 | 4.8 → 4.8 ms | 102.8 → 102.2 ms | 50 / 27 ms | 19.0 MiB |
| Portrait, finest 4 px | 10.5 → 10.4 | 7.4 → 10.8 ms | 102.6 → 102.7 ms | 30 / 44 ms | 25.3 MiB |

The measured highlight cost is small on this Chromium machine, with no Long Tasks in the post-change windows. The shared 12 fps playback cadence remains below the 90% target. Chrome and Edge remain unmeasured, so #26's browser acceptance gate is open.

### Playback scheduler cadence correction

After the highlight comparison, the editor scheduler was adjusted to preserve fractional frame deadlines across animation-frame ticks. It allows a 1 ms timing tolerance at refresh-rate boundaries, advances from the previous deadline to avoid cumulative drift, and resynchronizes after a long pause. Playback still caps at 30 requests per second. React updates the visible playback position four times per second while preview frames publish at the source cadence.

The complete 12-scenario matrix was repeated on the same Chromium machine with three 11-second windows per scenario. All cases now meet the 90% displayed-cadence target: 12 fps sources rendered 12.0–12.1 draws per second; 23.976 fps rendered 24; and 30, 60, and near-limit 1080p60 sources rendered about 30. The four Pixelated configurations rendered 12.0–12.1 draws per second. The highest scenario-median worker p95 was 17.7 ms (portrait ASCII), below its 83.3 ms source interval. No Long Tasks, stale replies, or queue replacements were observed. The default landscape 12 fps control also measured 12.1 draws per second both with and without app/worker diagnostics, a 0% cadence difference.

The 1080p60 near-limit case now reaches about 30 draws per second with 14.7 ms worker p95. Its seek p95 improved from 688.5 ms after canvas reuse to 520 ms, and still misses the 150 ms budget. Appearance p95 was 42.1 ms. Keep #13 open for the remaining seek latency work. The scheduler now passes the cadence hypothesis on this Chromium setup; Chrome and Edge remain unmeasured.

### Distant forward seeks

Playback keeps a sequential sample iterator for normal frame advances. When the requested timestamp jumps forward by more than 0.5 seconds (or four source frames, whichever is greater), the worker restarts that iterator at the requested timestamp rather than decoding all intervening frames. Backward seeks already restart the iterator.

On the same near-limit fixture, this reduced seek p95 from 520 ms to 384.9 ms across 20 seek samples. It preserves 30.1 preview draws per second and 14.7 ms scenario-median worker p95 across three playback windows. The 384.9 ms seek p95 still exceeds the 150 ms target, so #13 remains open. Mediabunny's sparse `getSample` path and its `optimizeForLatency` decoder hint did not improve this case and were discarded.

A fresh targeted repeat of the near-limit ASCII scenario on 2026-10-28 used the same Chromium 155.0.8059.84 machine and fixture, with three 11-second playback windows and 20 seek/appearance samples. It measured 30.1 draws per second in each window, p95 draw gaps of 36.1–37.2 ms, and worker p95 of 13.2–14.8 ms. The seek p50/p95 was 157.4/275.8 ms and appearance p95 was 26.1 ms. This repeat is faster than the earlier 384.9 ms seek p95 but still misses the 150 ms target. No long tasks, stale replies, or replaced pending requests were observed. Continuous-playback sample lookup p95 remained 0.4 ms; seek samples do not currently report that stage separately, so the gap is consistent with a random-access decode cost but does not isolate it. This targeted run is recorded in `test-results/pixelated-performance/results.json` (ignored local output); the summarized result is committed here. #13 remains open.

After the forward-seek change, the four Pixelated cases measured worker p95 of 6.9 ms (landscape default), 10.8 ms (landscape finest), 6.6 ms (portrait default), and 10.3 ms (portrait finest). Their seek / appearance p95 values were 27.3 / 26.6 ms, 27 / 42.4 ms, 26.8 / 38 ms, and 27.8 / 42.3 ms respectively. All four stayed at 12.0–12.1 draws per second. This completes the Chromium visual-treatment performance gate for #26, while Chrome and Edge remain to be checked.

Canvas draw calls measure frames painted by the app, not monitor presentation or perceived smoothness. Long Tasks and JavaScript heap samples cover the page main thread only. They do not include the worker, decoded-frame memory, GPU allocations, or total browser-process memory. The fixtures exercise maximum duration, dimensions, and cadence together; they do not approach the 100 MB file-size limit. The matrix combines source-color mode with default density only; it does not test every density/color combination.

## Remaining validation

### Supported-browser matrix (2026-10-28)

The same 13-configuration matrix was run in official Chrome for Testing 156.0.8078.73 and Microsoft Edge 156.0.4314.50. Each browser completed three sustained 11-second windows per configuration and 20 seek plus 20 appearance samples per configuration. The draw-rate and p95 frame-gap columns report medians across the three windows; interaction p95 values come from the 20 samples collected in the final window. Both runs used the machine and instrumentation described above. They ran headless with the configured desktop viewport; this is automated browser evidence, not a manual headed usability review.

| Scenario | Chrome draws/s | Chrome p95 gap | Chrome seek / appearance p95 | Edge draws/s | Edge p95 gap | Edge seek / appearance p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Landscape 12 fps, low density | 12.0 | 86.8 ms | 25.1 / 24.8 ms | 12.1 | 86.2 ms | 26.1 / 25.8 ms |
| Landscape 12 fps, default density | 12.1 | 86.3 ms | 27.9 / 26.9 ms | 12.1 | 87.1 ms | 27.5 / 26.6 ms |
| Landscape 12 fps, high density | 12.0 | 85.9 ms | 30.8 / 27.9 ms | 12.1 | 86.2 ms | 30.2 / 26.7 ms |
| Landscape 12 fps, source color | 12.1 | 86.5 ms | 27.7 / 27.3 ms | 12.1 | 85.9 ms | 26.5 / 27.1 ms |
| Portrait 12 fps, default density | 12.1 | 86.3 ms | 35.0 / 26.9 ms | 12.1 | 88.3 ms | 42.9 / 26.7 ms |
| Landscape 30 fps | 30.0 | 36.5 ms | 27.8 / 28.4 ms | 30.0 | 37.2 ms | 27.4 / 27.1 ms |
| Landscape 23.976 fps | 24.0 | 51.1 ms | 27.9 / 27.5 ms | 24.0 | 51.2 ms | 27.1 / 26.5 ms |
| Landscape 60 fps | 30.0 | 36.3 ms | 28.5 / 27.2 ms | 30.1 | 37.3 ms | 28.5 / 27.3 ms |
| Near-limit 1080p60, 14.9 s | 30.0 | 35.9 ms | 260.3 / 27.5 ms | 30.1 | 37.6 ms | 310.4 / 26.7 ms |
| Pixelated landscape, 8 px grid | 12.1 | 86.1 ms | 14.4 / 27.8 ms | 12.1 | 87.2 ms | 27.3 / 27.0 ms |
| Pixelated landscape, 4 px grid | 12.1 | 86.1 ms | 27.3 / 42.6 ms | 12.1 | 85.5 ms | 28.6 / 26.9 ms |
| Pixelated portrait, 8 px grid | 12.1 | 85.1 ms | 26.2 / 27.6 ms | 12.1 | 86.3 ms | 25.5 / 27.0 ms |
| Pixelated portrait, 4 px grid | 12.0 | 86.0 ms | 27.6 / 27.8 ms | 12.1 | 87.6 ms | 29.5 / 41.5 ms |
| Pixelated landscape, 30 fps, 8 px grid | 30.1 | 36.6 ms | 27.6 / 27.5 ms | 30.1 | 36.8 ms | 27.5 / 26.8 ms |
| Pixelated landscape, 30 fps, 4 px grid | 30.0 | 36.3 ms | 27.9 / 40.8 ms | 30.1 | 37.1 ms | 27.2 / 42.4 ms |
| Pixelated portrait, 30 fps, 8 px grid | 30.0 | 36.3 ms | 28.0 / 27.2 ms | 30.1 | 36.6 ms | 28.4 / 26.9 ms |
| Pixelated portrait, 30 fps, 4 px grid | 30.0 | 36.7 ms | 28.3 / 27.5 ms | 30.1 | 37.4 ms | 27.4 / 42.0 ms |

All measured configurations meet the cadence target (at least 90% of capped source cadence) and the frame-gap target (p95 no greater than 1.5 target intervals). Appearance p95 remains below 250 ms. The 150 ms seek budget passes in every listed case except near-limit 1080p60: Chrome measured 260.3 ms and Edge 310.4 ms. This budget miss keeps #13 open. Both browsers had zero Long Tasks, stale replies, and replaced pending requests. Peak page-JavaScript heap across the windows was 27.0 MiB in Chrome and 25.7 MiB in Edge; these measurements exclude decoder, worker, GPU, and browser-process memory.

The four 30 fps Pixelated scenarios were run as a targeted extension after the 13-case matrix, again with three 11-second windows and 20 seek/appearance samples per configuration. They meet the capped 30 fps cadence and frame-gap targets in both browsers. Their complete records are [Chrome Pixelated 30 fps](pixelated-performance-chrome-pixelated-30fps.json) and [Edge Pixelated 30 fps](pixelated-performance-edge-pixelated-30fps.json).

The three-window diagnostics-disabled control measured the same 12.1 draws/s as the instrumented landscape 12 fps default-density case in both browsers (0% cadence difference). Canvas instrumentation self-time was 0.4–0.7 ms per window in Chrome and 0.6–1.0 ms in Edge. Raw per-window reports are [Chrome 156](pixelated-performance-chrome-156.json) and [Edge 156](pixelated-performance-edge-156.json).

### Matched pre-tuning baseline

To capture a comparable baseline on the newly available supported browsers, the same opt-in test was run at the measured baseline commit `1f06126` on this machine with the same Chrome and Edge binaries and fixtures. That commit contains the nine ASCII configurations in #31; the four Pixelated scenarios were added afterward. Each ASCII configuration used three 11-second windows and 20 seek/appearance samples in the final window. Draw-rate and gap values below are medians across the three windows. For the post-tuning values, see the corresponding ASCII rows in the supported-browser matrix above. Raw data: [Chrome baseline](pixelated-performance-chrome-156-baseline.json), [Edge baseline](pixelated-performance-edge-156-baseline.json).

| ASCII configuration | Chrome baseline draws/s | Chrome p95 gap | Chrome seek / appearance p95 | Edge baseline draws/s | Edge p95 gap | Edge seek / appearance p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Landscape 12 fps, low density | 12.1 | 87.0 ms | 22.9 / 11.2 ms | 12.1 | 86.9 ms | 25.4 / 26.3 ms |
| Landscape 12 fps, default density | 12.1 | 86.5 ms | 27.9 / 27.1 ms | 12.1 | 86.2 ms | 26.7 / 26.8 ms |
| Landscape 12 fps, high density | 12.1 | 86.5 ms | 27.5 / 27.5 ms | 12.1 | 86.9 ms | 27.5 / 26.4 ms |
| Landscape 12 fps, source color | 12.0 | 86.3 ms | 27.2 / 27.7 ms | 12.1 | 87.0 ms | 30.7 / 27.0 ms |
| Portrait 12 fps, default density | 12.1 | 86.1 ms | 32.3 / 27.4 ms | 12.1 | 87.7 ms | 27.7 / 26.5 ms |
| Landscape 30 fps | 30.0 | 36.6 ms | 28.3 / 27.3 ms | 30.0 | 37.1 ms | 27.6 / 27.8 ms |
| Landscape 23.976 fps | 24.0 | 51.1 ms | 27.5 / 27.2 ms | 24.0 | 51.2 ms | 27.4 / 27.3 ms |
| Landscape 60 fps | 30.0 | 36.5 ms | 28.5 / 42.9 ms | 30.1 | 37.2 ms | 27.9 / 27.3 ms |
| Near-limit 1080p60, 14.9 s | 30.1 | 36.7 ms | 292.4 / 27.4 ms | 30.1 | 37.1 ms | 275.6 / 27.1 ms |

On this matched setup, both browsers already meet the cadence and frame-gap targets at `1f06126`. The newer Chrome 156 baseline is materially faster than the earlier Chromium 155 report, so the older numbers are not used for before/after claims here. Post-tuning near-limit seek p95 changed from 292.4 to 260.3 ms in Chrome, and from 275.6 to 310.4 ms in Edge. These results show a small Chrome improvement and an Edge regression; both remain above 150 ms. The current forward-seek restart heuristic therefore does not establish a cross-browser seek fix. Keep #13 open for the seek budget and a correction that is validated in both browsers.

The ASCII matrix samples source color at default density, not every density/color combination. Pixelated performance covers 12 and 30 fps short portrait/landscape fixtures at default and finest grids; it does not cover 60 fps or near-limit Pixelated sources. The near-limit ASCII case combines maximum duration, dimensions, and cadence but does not approach the 100 MB input-size limit. The 100 MB boundary is covered by source-admission tests, not playback measurements. Heap evidence is page-only and cannot establish total media/process memory or a cross-device budget.

The supplied-reference comparison and approved highlight treatment are documented above. Automated performance runs used official Chrome and Edge in headless mode. The editor was also opened in headed Chrome 156 and Edge 156 with the local fish fixture; the Pixelated preview was visually inspected in each. These visual checks do not replace longer manual playback review. The media stays local as required by ADR-0001. Playback tuning does not change the selected treatment or reduce export fidelity.

The media stays local as required by ADR-0001. Playback tuning does not change the selected treatment or reduce export fidelity.

### Near-limit seek stage diagnosis

An additional targeted run on 2026-10-28 paired each of 20 seek-to-presentation samples with worker stage timings. The default 1080p60 fixture has H.264 keyframes every 250 frames (4.17 seconds), confirmed by `ffprobe`. In Chrome 156, seek p95 was 388.0 ms; worker sample lookup/decode alone was 353.0 ms p95, while ASCII rendering was 12.1 ms and bitmap creation 4.4 ms. Edge 156 showed the same shape: 388.4 ms seek p95, 358.4 ms sample/decode, 13.9 ms rendering, and 5.2 ms bitmap creation. The main-thread presentation adds under 1 ms at p95. These stage timings locate the dominant cost in random-access decoding rather than ASCII painting or browser presentation.

Two alternatives were measured. Chrome's software-preferred decoder reduced seek p95 to 308.5 ms, still above the 150 ms budget; the browser rejected hardware-preferred configuration as unsupported in both headless Chrome and Edge. A native `HTMLVideoElement` seek on the original long-GOP source measured 310.5 ms in Chrome and 309.3 ms in Edge. A controlled copy of the same fixture with a one-second keyframe interval (60 frames) measured 124.5 ms p95 through the Chrome preview pipeline and 86.4 ms through the native video element. Cadence, dimensions, duration, and content stayed the same. This supports GOP length as the main cause, but does not fix or waive the budget for admitted long-GOP files. Raw measurements are in [preview-seek-diagnostics-chrome-edge.json](preview-seek-diagnostics-chrome-edge.json).
