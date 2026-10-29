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

Collected 2026-10-28 with Chrome for Testing 156.0.8078.73 and Microsoft Edge 156.0.4314.50 on Linux x86_64, Intel Core i5-10210U (4 cores / 8 logical CPUs), and 16 GiB RAM. Each scenario used a fresh browser process. Fixtures used FFmpeg `testsrc2`, H.264, `yuv420p`, `ultrafast`, and CRF 28. The editor was served locally with external requests blocked. The downloaded ZIP was extracted, then `index.html` was opened with `file://`. Generation time ends at the download event; startup ends when the offline example's Play control is ready. Playback ran for 5 seconds. Canvas `fillText` calls timestamped each completed grid; gaps are between completed displayed frames. Process RSS was sampled every 100 ms by summing processes launched from the browser executable. It includes browser overhead, can miss short peaks, and is not attributable to the page alone. `performance.memory` is exposed as a coarse, privacy-limited value in these runs and is not used as a peak-memory measure.

| Case | Grid × frames / cells | ZIP bytes | Generate ms C/E | Start ms C/E | Frames in 5 s C/E | Median / p95 gap ms C/E |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Landscape, 2 s, 12 fps, Density 24 | 24 × 7 × 24 / 4,032 | 10,176 | 221 / 242 | 72 / 81 | 59 / 59 | 83.4 / 83.8 · 83.3 / 83.6 |
| Landscape, 2 s, 12 fps, Density 88 | 88 × 27 × 24 / 57,024 | 27,127 | 219 / 403 | 66 / 99 | 59 / 60 | 83.3 / 83.9 · 83.3 / 84.4 |
| Landscape, 2 s, 12 fps, Density 160 | 160 × 50 × 24 / 192,000 | 60,573 | 256 / 278 | 94 / 111 | 59 / 59 | 83.5 / 84.9 · 83.3 / 86.6 |
| Portrait, 4 s, 12 fps, Density 160 | 160 × 156 × 48 / 1,198,080 | 285,829 | 772 / 812 | 156 / 147 | 59 / 59 | 83.4 / 88.3 · 83.2 / 86.4 |
| Minimum admitted aspect, 4 s, 12 fps, Density 160 | 160 × 156 × 48 / 1,198,080 | 213,572 | 1,171 / 1,271 | 192 / 168 | 59 / 59 | 83.5 / 86.6 · 82.8 / 90.4 |
| Source color, 4 s, 12 fps, Density 88 | 88 × 27 × 48 / 114,048 | 259,135 | 643 / 768 | 119 / 120 | 59 / 59 | 83.4 / 85.3 · 83.3 / 86.2 |
| Fractional, 4 s, 23.976 fps, Density 88 | 88 × 27 × 96 / 228,096 | 88,585 | 1,074 / 1,168 | 67 / 105 | 119 / 119 | 49.4 / 50.3 · 48.9 / 50.8 |
| Capped, 2 s, 60 fps source, Density 88 | 88 × 27 × 60 / 142,560 | 56,358 | 712 / 798 | 70 / 76 | 150 / 149 | 33.4 / 34.2 · 33.3 / 34 |
| Near 15 s, 29.97 fps, Density 88 | 88 × 27 × 447 / 1,062,072 | 383,252 | 9,439 / 8,656 | 132 / 122 | 149 / 149 | 33.4 / 34 · 33.3 / 34.5 |

C/E values are Chrome / Edge in that order. Results are observations on this machine, not CI thresholds. The largest case took about 9 seconds to generate, opened in 114–138 ms, and sustained about 30 displayed frames per second in both browsers. Sampled aggregate browser-process RSS ranged from 1042–1306 MiB during full-grid generation and 1033–1369 MiB during direct-delta generation in Chrome; Edge ranged from 963–1207 MiB and 966–1268 MiB respectively. Sampled full-grid consumer RSS ranged from 971–1009 MiB in Chrome and 864–904 MiB in Edge during offline playback. Because every scenario launches a fresh browser, these ranges include its idle process overhead. They should not be interpreted as the application's incremental or maximum device memory requirement. The existing 32,000,000-byte decoded-data estimate remains a conservative bound for retained frame data; decoder, Canvas, browser, and temporary package memory sit outside that estimate.

### Full grids, compression, and row deltas

The shipped ZIP uses complete independently seekable grids. The benchmark-only alternative writes changed character and source-color rows directly during source-frame sampling. It packages a local-file runnable example, reusable player API, delta `data.json`, and integration guide. Its data schema is experimental and is not part of the shipped version 1 contract. Both producers and both consumers were measured in separate fresh Chrome and Edge processes. Generation and consumer process RSS was sampled every 100 ms; these totals include browser idle overhead and can miss brief peaks. Twenty deterministic seeks measured the synchronous API call through Canvas drawing. Playback cadence was measured over five seconds. Candidate decoded-data estimates include the retained delta rows and one reconstructed full grid; they estimate retained representation data, not total process memory.

| Case | Full / delta ZIP bytes | Generation ms C full/delta · E full/delta | Startup ms C full/delta · E full/delta | Seek p95 ms C full/delta · E full/delta | Canvas gap p95 ms C full/delta · E full/delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| Landscape, 2 s, Density 24 | 10,176 / 8,757 | 221/220 · 242/245 | 72/68 · 81/61 | 0.2/0.3 · 0.5/0.3 | 83.8/83.8 · 83.6/83.6 |
| Landscape, 2 s, Density 88 | 27,127 / 26,338 | 219/216 · 403/268 | 66/84 · 99/66 | 16.1/17.9 · 18.4/18.7 | 83.9/83.9 · 84.4/84.3 |
| Landscape, 2 s, Density 160 | 60,573 / 60,703 | 256/239 · 278/287 | 94/84 · 111/81 | 21.3/22 · 24.7/23.4 | 84.9/85.3 · 86.6/85.1 |
| Portrait, 4 s | 285,829 / 303,284 | 772/716 · 812/805 | 156/147 · 147/157 | 48.4/51.5 · 59.4/61.4 | 88.3/87.3 · 86.4/86.2 |
| Minimum admitted aspect, 4 s | 213,572 / 224,376 | 1171/1025 · 1271/1235 | 192/177 · 168/158 | 52.5/52.2 · 58.9/57.2 | 86.6/103.5 · 90.4/89.7 |
| Source color, 4 s | 259,135 / 259,268 | 643/643 · 768/707 | 119/113 · 120/103 | 18.8/19.1 · 23.9/21.1 | 85.3/85.1 · 86.2/84.3 |
| Fractional, 4 s | 88,585 / 88,844 | 1074/1084 · 1168/1126 | 67/88 · 105/85 | 16.7/18.8 · 19.4/19.6 | 50.3/50.6 · 50.8/50.8 |
| Capped, 2 s | 56,358 / 55,734 | 712/721 · 798/771 | 70/77 · 76/81 | 16.9/17.9 · 18.7/19.2 | 34.2/34 · 34/35.8 |
| Near 15 s | 383,252 / 385,676 | 9439/8543 · 8656/9183 | 132/138 · 122/114 | 18.2/18.4 · 20/20.9 | 34/33.8 · 34.5/34.3 |

C/E values are Chrome / Edge in that order. DEFLATE full-grid `data.json` was smaller than delta `data.json` in all nine cases, while the complete four-file delta ZIP was smaller in three cases. Delta's estimated retained data was 3–67% lower, depending on changed rows and colors. Sampled generation RSS ranges were 1042–1306 MiB full-grid / 1033–1369 MiB delta in Chrome and 963–1207 / 966–1268 MiB in Edge. Sampled consumer RSS ranges were 971–1009 / 955–1013 MiB in Chrome and 864–904 / 881–916 MiB in Edge. Both producers and consumers now have measurements; the samples do not show a consistent memory or playback advantage for deltas. Full grids remain the v1 choice because their complete bundle is smaller in six of nine fixtures, supports direct frame addressing, and avoids replaying deltas for backward seeks. These measurements do not claim either representation is inherently smaller or faster than MP4. ZIP compression does not change decoded frame storage or playback work.

The full-grid matrix is in [Chrome 156](code-output-chrome-156.json) and [Edge 156](code-output-edge-156.json). The direct delta-producer archives and isolated offline-consumer measurements are in [Chrome 156 delta results](code-output-delta-producer-chrome-156.json) and [Edge 156 delta results](code-output-delta-producer-edge-156.json). The benchmark opened each archive's `index.html` from `file://` and checked a full initial grid; it also loaded `player.js` and `data.json` from a separate local-file consumer, exercised the public player API, measured 20 seeks, and recorded playback cadence. Results are local observations, not generic CI thresholds.

Raw per-case measurements, including source probe data, both player metrics, candidate sizes and decoded-data estimates, Canvas frame gaps, seek timings, and sampled process RSS, are in [Chrome 156](code-output-chrome-156.json) and [Edge 156](code-output-edge-156.json). These current supported-browser runs supplement the earlier functional suite: editor download, extracted offline example, separate consumer, recovery, and MP4 regression workflows passed 36 tests in each browser.
