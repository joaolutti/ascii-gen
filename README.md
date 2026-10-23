# ASCII Video

A local browser app that turns an H.264 MP4 into a silent ASCII MP4. Source video processing stays in the browser; no video is sent to a server.

## Development

See [project rules](RULES.md) for the branch workflow and commit convention.

- `npm install` installs the exact dependency tree in `package-lock.json`.
- `npm run dev` starts Vite.
- `npm run build` type-checks and builds for production.
- `npm run lint` runs ESLint.
- `npm run format:check` checks Prettier formatting; `npm run format` formats files.
- `npm test` runs the Playwright browser workflow in Chromium. Install its browser with `npx playwright install chromium`.

The workflow fixture is generated with `npm run fixture` (requires FFmpeg). Use `npm run inspect:fixture` and `npm run inspect:output -- <file>` to inspect media independently with ffprobe.

Export requires browser WebCodecs H.264 encoding. Unsupported browsers report this and do not offer a fallback.

Source admission uses the media track's actual metadata. Duration must be less than 15 seconds; width and height are
compared in display orientation against 1920 × 1080 for landscape/square and 1080 × 1920 for portrait; the measured
maximum frame rate must be at most 60 fps. The file size limit is decimal: 100 MB means 100,000,000 bytes, inclusive.
The file extension and browser-reported MIME type do not establish the codec; the MP4 video track must identify as
H.264. Decode and H.264 MP4 encode support are checked locally before export is enabled.

The Playwright source-admission workflow generates deterministic H.264 fixtures with FFmpeg from `testsrc2` at
explicit sizes, frame rates, and durations. It compares 14.9 seconds with 15 seconds, 60 fps with 61 fps, the exact
1920 × 1080 landscape and 1080 × 1920 portrait edges with a 1922 × 1080 over-limit clip, and 100,000,000 bytes with
100,000,001 bytes. A VP9 WebM fixture checks container/codec rejection, and a browser capability override checks the
unavailable H.264 encoder state. It also drops an unsupported file and selects a valid clip after rejection to verify
recovery. The existing conversion workflow exercises successful decode and export with a real H.264 MP4.
