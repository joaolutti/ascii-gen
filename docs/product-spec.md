# ASCII video converter: first version

Published implementation spec: [GitHub issue #1](https://github.com/joaolutti/ascii-gen/issues/1).

## Purpose

Create attractive ASCII videos through quick experimentation and easy downloads. The tool is for general visual experimentation, without tailoring the workflow to social posts.

Users provide a source video, adjust its ASCII appearance in a live preview, and download an ASCII video. Domain terminology is defined in [GLOSSARY.md](../GLOSSARY.md).

## Input and compatibility

- Browser app designed for desktop use first, targeting Chrome and Edge.
- One H.264 MP4 source video at a time.
- Duration must be strictly less than 15 seconds; reject videos of 15 seconds or longer.
- Maximum input: 1080p, 60 fps, and 100 MB. Accept both landscape and portrait orientation.
- Users trim videos elsewhere; the first version has no trimming tool.
- Check file and device support early. Clearly explain unsupported files, exceeded limits, or unavailable MP4 encoding.
- All video processing stays on the user's device, with no uploads or server fallback. See [ADR-0001](adr/0001-local-video-processing.md).

## Rendering and controls

Represent each frame as a regular grid of characters selected according to the brightness of the corresponding source region.

Provide these controls:

- **Density:** number of character columns; more columns produce finer detail.
- **Brightness** and **contrast**.
- **Inversion:** reverse the brightness-to-character mapping without swapping chosen colors.
- **Character preset:** Classic, Minimal, or Binary.
- **Foreground color** and **background color:** freely selectable, defaulting to white characters on near-black.
- **Source-color mode:** sample character colors from the source video while keeping the background color independently selectable. Brightness still determines character selection.

The three starting character presets are:

- **Classic:** a varied ASCII character range.
- **Minimal:** a small set such as spaces, dots, and hashes.
- **Binary:** `0` and `1`, with spaces for dark regions.

Custom character strings are deferred.

## Preview and editor

Use a minimal, understated aesthetic with neutral surfaces and simple controls. Avoid excessive styling and colorful decoration; the video and its color settings provide the visual emphasis.

- Start with a drag-and-drop file area and a file picker.
- After loading, show a large preview with a control panel beside it and playback controls below.
- Loop the preview, with pause and scrubbing available.
- Update the appearance live as parameters change.
- Let users choose ASCII characters or brightness-sized square cells as the render mode.
- Provide clear **Replace video**, **Reset controls**, and **Generate & download MP4** actions.
- Retain the selected style when replacing the source video.
- Match the exported composition, colors, and character density in the preview.

## Export

- Export a silent MP4; source audio is omitted.
- Preserve the source's proportions and duration.
- Fit landscape output within 1280×720 and portrait output within 720×1280.
- Avoid upscaling smaller source videos.
- Cap output at 30 fps while preserving lower source frame rates.
- Render every required export frame independently of preview playback, so preview slowdowns do not cause missing export frames.
- Start generation through the primary **Generate & download MP4** action, which requests one browser download when the current operation succeeds.
- Show progress and a Cancel action. Temporarily lock editing during export.
- Preserve settings after cancellation or failure.
- Report that the download was requested, not that saving finished. Keep a **Save MP4 again** recovery action for the completed artifact, and allow another export after further adjustments.
- Offer versioned ASCII code output as a separate local generation path. Its standalone player, data contract, limits, measurement record, and integration guidance are documented in [code-output.md](code-output.md).

## Session and deferred scope

Handle one video at a time, retaining settings during experimentation. Refreshing the page starts a fresh session.

Deferred from the first version:

- Custom characters.
- Source audio preservation.
- Additional effects, including glow, glitch, and CRT distortion.
- Accounts and saved projects.
- Batch conversion.
- Additional download formats and export quality settings.
- Integrated trimming and mobile-focused editing.

## Development stack

- **Language:** TypeScript in strict mode.
- **UI and build:** React and Vite.
- **Styling:** CSS Modules.
- **Rendering:** Canvas 2D for consistent preview and export rendering.
- **Video processing:** Mediabunny with browser WebCodecs for local media input, frame processing, and MP4 output, with actual device capability checks.
- **Background processing:** Web Workers for expensive video work, keeping editor interactions responsive.
- **Development tooling:** npm, ESLint, and Prettier. Pin dependency versions in the lockfile during implementation.
- **Testing:** Playwright for browser workflows, including Chrome and Edge compatibility checks. FFmpeg and ffprobe are development/test tools for preparing fixtures and independently inspecting exported media.

## Testing boundary

Test the editor through its public browser workflow, from file selection and control interactions to the downloaded MP4. Inspect that output independently to verify playable silent video, timing, proportions, dimensions, frame rate, and visual consistency with the preview.

Cover input and capability failures, rendering controls, playback, replacement and reset, cancellation and recovery, repeated exports, and the absence of video uploads. Assert external behavior rather than internal helper functions or component structure. Verify real encoding on target browsers/devices and manually review the minimal aesthetic and character preset quality.

## Inspiration

The user supplied [this tweet](https://x.com/kail_designs/status/2113322781513592958?s=20) as inspiration. Its media could not be inspected during design; the agreed behavior above is the specification, with no exact visual match established.
