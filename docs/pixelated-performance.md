# Pixelated motion performance

## Current behavior

The editor advances preview time using elapsed wall-clock time and publishes at most 30 preview timestamps per second. The worker processes one preview at a time and retains only the newest pending request. The editor paints a reply only when its sequence matches the latest requested preview and is newer than the last displayed result. Frames made obsolete by a later seek or treatment change are closed without painting.

The same playback scheduler is used by ASCII mode. Pixelated sampling, cell placement, spacing, colors, brightness, contrast, and inversion were not changed as a performance workaround.

## Measurement method

The opt-in Playwright workflow at `e2e/pixelated-performance.spec.ts` uses the public file picker and controls with the bundled moving `public/fixtures/landscape.mp4`. It records visible canvas changes for 4 seconds at Grid step 8 and 4, median and p95 gaps between changed frames, the main page's JavaScript heap before and after each window, seek latency, and brightness-change latency. The canvas is sampled on animation frames, which adds some main-thread measurement overhead.

Run it separately from general browser checks:

```sh
PIXELATED_PERF=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm test -- --workers=1 e2e/pixelated-performance.spec.ts
```

General CI skips this hardware-sensitive measurement unless `PIXELATED_PERF=1` is set. The heap values below cover the page's JavaScript heap only; they do not report worker heap, decoded frame buffers, GPU allocations, or total process memory. Heap start/end values are affected by garbage collection and are not a reliable peak-memory estimate.

## Baseline and follow-up

Captured 2026-10-23 on the repository's bundled fixture. The runner reports an Intel Core i5-10210U (4 cores / 8 threads) and 15 GiB system memory. Playwright launched `/usr/bin/chromium` 154.0.8037.97; its configured Desktop Chrome user agent reports Chrome 156.0.8078.4 on Windows. This is one headless runner and is not a representative device survey.

| Measurement | Before scheduler change | Scheduler change, before starvation fix |
| --- | ---: | ---: |
| Source fixture | 320×180, 12 fps, 2 s | 320×180, 12 fps, 2 s |
| Observation window, each grid | 4 s | 4 s |
| Grid step 8: changed-frame cadence | 10.00 fps | 10.50 fps |
| Grid step 8: median / p95 frame gap | 100 / 116.7 ms | 83.4 / 166.7 ms |
| Grid step 8: page JS heap start → end | 7.52 → 11.22 MB | 8.52 → 15.64 MB |
| Grid step 4: changed-frame cadence | 10.25 fps | 7.25 fps |
| Grid step 4: median / p95 frame gap | 100 / 116.7 ms | 99.9 / 500 ms |
| Grid step 4: page JS heap start → end | 14.06 → 12.49 MB | 8.63 → 8.23 MB |
| Seek latency | 104 ms | 117 ms |
| Brightness-change latency | 212 ms | 310 ms |

The baseline cadence is below the 12 fps source cadence and below the 30 fps cap target. The first scheduler attempt increased request frequency but showed gaps up to 500 ms at Grid step 4: sequence-based stale-result dropping could starve the preview under load. The worker/editor sequence handling was then changed to let an in-flight frame display in order while retaining only the newest queued request. A valid performance measurement after that fix is **not available**: the opt-in run remained at “Reading source video locally…” until the 60-second test timeout. In a separate focused Pixelated run after the change, one workflow passed and one failed during fixture admission. Do not treat the intermediate measurements as post-fix results.

## Provisional budgets

These are working targets derived from the measured source cadence and the 30 fps product cap; they need confirmation on representative desktop Chrome and Edge hardware:

- Sustained changed-frame cadence: at least 90% of `min(source fps, 30)`. That means at least 10.8 fps for this 12 fps fixture and at least 27 fps for a 30 fps source.
- p95 gap between changed frames: no more than 1.5 times the capped source-frame interval. That is 125 ms at 12 fps and 50 ms at 30 fps.
- Seek latency: p95 no more than 150 ms.
- Appearance-change latency: p95 no more than 250 ms.
- Preview work remains bounded to one in-flight request and one replaceable newest request. Validate peak memory on target devices separately; this runner's JS heap deltas cannot establish a whole-process memory budget.

The single baseline observation misses the cadence target (10.00 and 10.25 fps versus 10.8 fps), while its seek and appearance latencies fall within the provisional budgets. Repeated baseline runs and valid post-fix runs are still required before treating these budgets as established.

## Browser, motion, and visual gates

- Chromium 154.0.8037.97 was available. Some focused Pixelated browser workflows completed, including the mode/control/export workflow; other attempts intermittently stalled during local source admission. This runner therefore does not establish reliable H.264 behavior across sessions or hardware. The product's MP4 capability probe succeeded in runs that reached the editor, but there is no stable post-change H.264 result.
- No Edge binary is installed in the runner. Edge compatibility remains unverified.
- The bundled fixture is only 320×180 at 12 fps and 2 seconds. It does not represent 1080p/60fps, portrait and landscape at supported maximums, or the performance of contemporary desktop hardware.
- The supplied X reference returned HTTP 403, and there is no supplied fish recording among repository fixtures. Manual comparison for regular spacing, recognizable silhouettes, internal tonal detail, and luminous highlights remains **incomplete**. The base treatment has not been declared visually sufficient; no glow, dithering, or tonal remapping was invented.
- Playback scheduling overlaps the shared playback work tracked by issue #13. Reuse this scheduler work when #13 is implemented; coordinate integration rather than adding a second playback clock.

This report does not close issue #26 or parent spec #17. The visual reference gate and representative-browser performance gates remain open.
