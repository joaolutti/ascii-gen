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

The browser available here was Chromium, not branded Chrome or Edge. The standalone file consumer and download path were exercised in Chromium; Edge was unavailable. Existing MP4 workflows remain separate, and the browser-specific preview timing data is not used as code-player evidence.
