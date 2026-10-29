# ASCII code output contract

The downloadable archive is a standalone, versioned ASCII code output. Version 1 contains `index.html`, `player.js`, `data.json`, and `README.txt`. The example runs from an extracted local folder without the source video, a build, a server, external fonts, or runtime libraries. It starts paused. The reusable API is `AsciiVideoPlayer.mount({ container, data })`; its returned instance provides play, pause, seek, loop control, current time, the mounted element, and `dispose()`.

`data.json` stores complete row-major character grids and optional six-digit RGB colors per cell. It records version, logical width and height, columns and rows, cell geometry, font size, foreground and background, duration, and each frame's timestamp and duration. Version 1 accepts 24–160 columns in steps of 8 and 1–450 frames. The player validates the contract before rendering. Its accessible Canvas surface draws each character at its recorded cell position, using the recorded font size and a system monospace font. Fixed-color frames use `foreground`; source-color frames use the sampled RGB value for each cell. Both modes keep the selected `background` independent. Glyph shape and spacing can differ between operating systems.

## Resource limits

The producer checks these limits before allocating frame data, checks the growing estimates before each frame is retained, verifies the serialized JSON byte length, preflights the package, and checks the final archive size. An over-limit request fails with: “This ASCII bundle exceeds the safe export limits. Lower Density in the editor and generate it again; duration, frame rate, and color fidelity are never reduced automatically.” The source and treatment stay selected, no download is made, and partial frame data is cleared on failure or cancellation. The user can lower Density and retry, or keep the current Density for later.

| Limit | Version 1 cap | Accounting |
| --- | ---: | --- |
| Cells in one frame | 28,000 | Bounds consumer work for one displayed grid. At the 0.5625 portrait ratio admitted by source sizing and 160 columns, the grid is 160 × 156 = 24,960 cells. |
| Cells across the output | 7,200,000 | Columns × rows × frames. |
| Frames | 450 | The 30 fps output cap over a source shorter than 15 seconds. |
| Serialized `data.json` | 5,000,000 bytes | Conservative preflight counts up to two JSON bytes per fixed-color cell or eight per source-color cell, plus row/frame structure; actual UTF-8 byte length is checked before packaging. |
| Estimated decoded frame data | 32,000,000 bytes | Conservative UTF-16 string cost (two bytes per character and twelve more per RGB cell), plus row and frame structure. This is a data-model budget, not a measured process-memory ceiling. |
| Final ZIP | 12,000,000 bytes | Final byte length is checked after packaging. The preflight also bounds the duplicate JSON in `index.html` and `data.json` before ZIP buffers are assembled. |

The values are deliberately separate: a cell-count cap cannot account for source-color strings, and a JSON cap cannot bound one exceptionally large displayed frame. The final ZIP uses standard DEFLATE compression through the browser's `CompressionStream('deflate-raw')`; extraction restores ordinary files, and the consumer needs no decompressor. Desktop Chrome and Edge support this path. The app disables code generation with an explanation when raw DEFLATE support is absent. MP4 encoding capability remains independent.

## Measurement record

Collected 2026-10-23 in system Chromium 154.0.8037.97, headless, on Linux x86_64 with an Intel Core i5-10210U (4 cores / 8 logical CPUs) and 16 GB RAM. Vite served the editor at `127.0.0.1:4173`; external requests were blocked. Each measurement began at the Generate click and ended at the download event. The archive was extracted with `unzip`; the runnable example was opened using a `file://` URL. Consumer startup is time from navigation start to the labeled Play button. The cadence values below were collected with the former DOM renderer by counting displayed-frame DOM mutations during one roughly 1-second Play window; they do not measure Canvas redraw performance. They are bounded observations, not long-run performance guarantees.

Fixtures were generated locally with FFmpeg `testsrc2`, `libx264`, `yuv420p`, `ultrafast`, and CRF 28, without audio. `ffprobe` verified their dimensions, frame rates, frame counts, and durations. The cases used 320×180 at 12 fps for 2 and 4 seconds; 320×180 at 23.976 fps for 4.004 seconds; 320×180 at 60 fps for 2 seconds; 320×180 at 29.97 fps for 14.914915 seconds; 180×320 and 360×640 at 12 fps for 4 seconds. The latter has the minimum 0.5625 landscape-to-portrait ratio accepted by source admission. Density values were 24, 88, and 160; source-color mode was also measured at Density 88. The repository's 320×180, 12 fps, 2-second fixture was included.

| Case | Grid / frames | Total cells | JSON bytes (gzip candidate) | Final ZIP bytes | Generate time | Consumer open | Mutations / ~1 s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 s, 12 fps, 88 columns | 88 × 27 / 24 | 57,024 | 63,551 (9,955) | 26,455 | 1.03 s | 102 ms | 12 |
| 4 s, 12 fps, 24 columns | 24 × 7 / 48 | 8,064 | 12,959 (2,974) | 12,322 | 1.85 s | 208 ms | 12 |
| 4 s, 12 fps, 88 columns | 88 × 27 / 48 | 114,048 | 128,235 (20,476) | 47,512 | 1.51 s | 113 ms | 12 |
| 4 s, 12 fps, 160 columns | 160 × 50 / 48 | 384,000 | 414,108 (55,725) | 118,151 | 1.68 s | 310 ms | 12 |
| 4 s, 12 fps, source color, 88 columns | 88 × 27 / 48 | 114,048 | 816,939 (125,912) | 265,449 | 2.04 s | 223 ms | 11 |
| 4 s portrait, 12 fps, 160 columns | 160 × 156 / 48 | 1,198,080 | 1,292,820 (139,295) | 287,715 | 2.86 s | 196 ms | 11 |
| 4 s, 0.5625 aspect, 12 fps, 160 columns | 160 × 156 / 48 | 1,198,080 | 1,268,490 (103,107) | 213,889 | 3.11 s | 165 ms | 12 |
| 14.914915 s, 29.97 fps source, 88 columns | 88 × 27 / 448 | 1,064,448 | 1,203,450 (188,031) | 382,261 | 22.45 s | 153 ms | 30 |
| 4.004004 s, 23.976 fps, 88 columns | 88 × 27 / 97 | 230,472 | 259,951 (40,711) | 87,991 | 2.86 s | 112 ms | 24 |
| 2 s, 60 fps source, 88 columns | 88 × 27 / 60 | 142,560 | 159,335 (24,609) | 55,501 | 3.35 s | 163 ms | 30 |

Timings varied with machine load and must not become generic CI thresholds. `performance.memory` reported a coarse constant in this headless run and does not expose worker/process peak memory; no peak-memory measurement is claimed. The full-grid JSON was 5–23% of its original byte count under gzip for these fixtures. ZIP DEFLATE reduced the measured final bundles to 11–36% of the equivalent uncompressed package size, while keeping ordinary full grids after extraction. Source-color startup and cadence were measured with this controlled fixture only; dynamic, high-entropy color video may compress less and take longer. No deltas were implemented: complete grids keep frames independently addressable for timestamp seeking and avoid reconstruction state. Compression materially reduces downloads while leaving decoded data and playback unchanged.

The largest measured case was 1,198,080 cells, about 6× below the 7,200,000 total-cell cap; the largest measured single grid was 24,960 cells, below the 28,000 cap. The hard byte caps also leave room for high-entropy inputs, which compress less than the deterministic fixtures. The generated portrait 4-second case and the near-15-second landscape case exercised high-area and high-frame-count work; near-15-second high-density portrait work exceeds the total-cell preflight and is rejected with lower-Density guidance. These are local representative measurements, not evidence that every accepted device will sustain every case.

The table above is historical Chromium 154 data. Current supported-browser runs are recorded below; existing MP4 workflows remain separate, and preview timing data is not used as code-player evidence.

## Current Chrome and Edge matrix

Collected 2026-10-28 with Chrome for Testing 156.0.8078.73 and Microsoft Edge 156.0.4314.50 on Linux x86_64, Intel Core i5-10210U (4 cores / 8 logical CPUs), and 16 GiB RAM. Each scenario used a fresh browser process. Fixtures used FFmpeg `testsrc2`, H.264, `yuv420p`, `ultrafast`, and CRF 28. The editor was served locally with external requests blocked. The downloaded ZIP was extracted, then `index.html` was opened with `file://`. Generation time ends at the download event; startup ends when the offline example's Play control is ready. Playback ran for 1.2 seconds. Canvas `fillText` calls timestamped each completed grid; gaps are between completed displayed frames. Process RSS was sampled every 100 ms by summing processes launched from the browser executable. It includes browser overhead, can miss short peaks, and is not attributable to the page alone. `performance.memory` is exposed as a coarse, privacy-limited value in these runs and is not used as a peak-memory measure.

| Case | Grid × frames / cells | ZIP bytes | Generate ms C/E | Start ms C/E | Frames in 1.2 s C/E | Median / p95 gap ms C/E |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Landscape, 2 s, 12 fps, Density 24 | 24 × 7 × 24 / 4,032 | 10,176 | 223 / 248 | 53 / 74 | 14 / 14 | 83.3 / 83.9 · 83.3 / 83.7 |
| Landscape, 2 s, 12 fps, Density 88 | 88 × 27 × 24 / 57,024 | 27,127 | 235 / 312 | 74 / 97 | 14 / 14 | 83.3 / 84.1 · 83.2 / 83.8 |
| Landscape, 2 s, 12 fps, Density 160 | 160 × 50 × 24 / 192,000 | 60,573 | 261 / 328 | 89 / 125 | 14 / 14 | 83.4 / 88.8 · 83.6 / 84.5 |
| Portrait, 4 s, 12 fps, Density 160 | 160 × 156 × 48 / 1,198,080 | 285,829 | 918 / 1,006 | 121 / 240 | 14 / 14 | 83.1 / 85.9 · 83.5 / 88.6 |
| Minimum admitted aspect, 4 s, 12 fps, Density 160 | 160 × 156 × 48 / 1,198,080 | 213,572 | 986 / 1,323 | 147 / 225 | 14 / 14 | 83.4 / 95.1 · 81.7 / 87.7 |
| Source color, 4 s, 12 fps, Density 88 | 88 × 27 × 48 / 114,048 | 259,135 | 608 / 710 | 99 / 147 | 14 / 14 | 83.3 / 84.4 · 83.1 / 85.5 |
| Fractional, 4 s, 23.976 fps, Density 88 | 88 × 27 × 96 / 228,096 | 88,585 | 1,356 / 1,413 | 72 / 126 | 28 / 28 | 48.9 / 50.6 · 48.9 / 50.1 |
| Capped, 2 s, 60 fps source, Density 88 | 88 × 27 × 60 / 142,560 | 56,358 | 905 / 943 | 94 / 108 | 35 / 36 | 33.4 / 33.9 · 33.3 / 34.0 |
| Near 15 s, 29.97 fps, Density 88 | 88 × 27 × 447 / 1,062,072 | 383,252 | 8,691 / 9,762 | 105 / 155 | 35 / 36 | 33.3 / 34.7 · 33.3 / 34.2 |

C/E values are Chrome / Edge in that order. Results are observations on this machine, not CI thresholds. The largest case took about 9 seconds to generate, opened in 105–155 ms, and sustained about 30 displayed frames per second in both browsers. Sampled aggregate browser-process RSS ranged from 1,042 to 1,283 MiB during generation and 1,186 to 1,519 MiB during offline consumer startup/playback in Chrome; Edge ranged from 938 to 1,204 MiB and 1,208 to 1,519 MiB respectively. Because every scenario launches a fresh browser, these ranges include its idle process overhead. They should not be interpreted as the application's incremental or maximum device memory requirement. The existing 32,000,000-byte decoded-data estimate remains a conservative bound for retained frame data; decoder, Canvas, browser, and temporary package memory sit outside that estimate.

### Full grids, compression, and row deltas

The shipped ZIP uses complete independently seekable grids. A benchmark-only row-delta consumer stores timestamps and changed rows, reconstructs frames for display, and can seek by replaying deltas from the first frame. Both consumers were opened from local files in separate fresh browser processes. Twenty deterministic seeks measured the synchronous API call through completed Canvas drawing; playback was measured for 1.2 seconds. Candidate decoded storage uses the same UTF-16-per-cell estimate as the full grid, plus one reconstructed full frame and row/frame structure. This is an estimate of retained data, not process memory.

DEFLATE made full-grid `data.json` smaller than the row-delta candidate in eight of nine cases (1,598 versus 1,505 bytes for the smallest case; 139,277 versus 148,588 bytes for portrait; 188,060 versus 189,872 bytes near 15 seconds). Delta's estimated decoded storage was 3–67% lower, depending on changed rows and colors. Across the matrix, delta consumer startup ranged from 23 ms faster to 17 ms slower in Chrome, and 40 ms faster to 5 ms slower in Edge. Seek p95 ranges overlapped: 0.3–53.8 ms full-grid / 0.3–54.3 ms delta in Chrome; 0.3–60.9 / 0.3–61.0 ms in Edge. The measured 1.2-second playback advanced within one frame of full-grid playback in every case; p95 gaps overlapped (Chrome 34.1–88.3 ms / 34.1–86.4 ms; Edge 33.9–89.9 ms / 34.2–87.3 ms).

Sampled consumer process RSS also overlapped: 947–996 MiB full-grid / 948–1,005 MiB delta in Chrome; 870–904 / 869–911 MiB in Edge. These numbers include browser overhead and show no meaningful peak-RSS improvement. The full-grid producer's sampled generation RSS was 1,038–1,293 MiB in Chrome and 950–1,250 MiB in Edge. The delta fixture was derived from completed full-grid JSON, so its transform does not measure peak generation memory for a producer that writes deltas while sampling video. That remains an explicit evidence gap.

The current evidence favors keeping the v1 full-grid representation: compressed bundle data is smaller in nearly all cases, while the delta consumer does not show consistent startup, seek, cadence, or process-RSS improvements. Full grids also stay independently addressable for seeks. The benchmark prototype is not shipped as a second player, and no claim is made that either representation is inherently smaller or faster than MP4. ZIP compression does not change decoded frame storage or playback work.

Raw per-case measurements, including source probe data, both player metrics, candidate sizes and decoded-data estimates, Canvas frame gaps, seek timings, and sampled process RSS, are in [Chrome 156](code-output-chrome-156.json) and [Edge 156](code-output-edge-156.json). These current supported-browser runs supplement the earlier functional suite: editor download, extracted offline example, separate consumer, recovery, and MP4 regression workflows passed 36 tests in each browser.
