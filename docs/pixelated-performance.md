# Preview playback performance

Playback time advances from elapsed time on `requestAnimationFrame` and publishes requests at the lower of source cadence or 30 fps. The worker processes one preview at a time and keeps only the newest pending request. Replies from the current preview generation are displayed monotonically; source replacement, seek, mode, or treatment changes invalidate older generations.

The opt-in Chromium harness at `e2e/pixelated-performance.spec.ts` is not yet integrated. The repository contains historical measurements from a 320×180, 12 fps, two-second fixture, but they were collected before the latest scheduler and generation changes and are not post-change evidence. A repeated 10-second matrix across density, source-color, orientation, source cadence, and near-limit media is still required before setting performance budgets.

The previous runner recorded Chromium 154 on one headless Intel Core i5-10210U environment. The supplied visual reference could not be retrieved, the fixture does not represent maximum supported media, and Edge is unavailable here. Those visual and browser checks remain open. Page JavaScript heap readings alone do not include worker, decoded-frame, GPU, or total process memory.

The media stays local as required by ADR-0001. Playback tuning does not change the selected treatment or reduce export fidelity.
