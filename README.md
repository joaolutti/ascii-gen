# ASCII Video

A local browser app that turns an H.264 MP4 into a silent ASCII MP4. Source video processing stays in the browser; no video is sent to a server.

## Development

- `npm install` installs the exact dependency tree in `package-lock.json`.
- `npm run dev` starts Vite.
- `npm run build` type-checks and builds for production.
- `npm run lint` runs ESLint.
- `npm run format:check` checks Prettier formatting; `npm run format` formats files.
- `npm test` runs the Playwright browser workflow in Chromium. Install its browser with `npx playwright install chromium`.

The workflow fixture is generated with `npm run fixture` (requires FFmpeg). Use `npm run inspect:fixture` and `npm run inspect:output -- <file>` to inspect media independently with ffprobe.

Export requires browser WebCodecs H.264 encoding. Unsupported browsers report this and do not offer a fallback.
