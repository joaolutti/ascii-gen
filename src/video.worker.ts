import {
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSampleSink,
  ALL_FORMATS,
} from 'mediabunny';
import type { CharacterPreset, Treatment } from './treatment';
import { createExampleHtml, createZip, playerJavaScript } from './codeBundle';

type Request =
  | {
      type: 'load';
      file: File;
      testExportFailure?: boolean;
      testExportDelay?: number;
    }
  | {
      type: 'preview';
      timestamp: number;
      sequence: number;
      treatment: Treatment;
    }
  | { type: 'export'; treatment: Treatment }
  | { type: 'code-bundle'; treatment: Treatment }
  | { type: 'cancel-export' }
  | { type: 'dispose' };
const scope = self as DedicatedWorkerGlobalScope;
const chars =
  ' .\'`^",:;Il!i~+_-?][}{1)(|\\/*tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
const ramps: Record<CharacterPreset, string> = {
  Classic: chars,
  Minimal: ' .#',
  Binary: ' 01',
};
const defaultTreatment: Treatment = {
  density: 88,
  brightness: 0,
  contrast: 100,
  inverted: false,
  preset: 'Classic',
  foreground: '#ffffff',
  background: '#111111',
  sourceColor: false,
};
let file: File | undefined;
let width = 0;
let height = 0;
let duration = 0;
let sourceFrameRate = 30;
let input: Input | undefined;
let track: Awaited<ReturnType<Input['getPrimaryVideoTrack']>>;
let sink: VideoSampleSink | undefined;
let canvas: OffscreenCanvas | undefined;
let latestPreviewSequence = 0;
let pendingPreview:
  { timestamp: number; sequence: number; treatment: Treatment } | undefined;
let processingPreview = false;
let exportCanceled = false;
let activeOutput: Output | undefined;
let didTestExportFail = false;

let testExportDelay = 0;
let testExportFailure = false;

function yieldToWorkerMessages() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function drawAscii(
  sample: {
    draw: (
      context: OffscreenCanvasRenderingContext2D,
      x: number,
      y: number,
      width?: number,
      height?: number,
    ) => void;
  },
  target = canvas,
  treatment: Treatment = defaultTreatment,
) {
  if (!target) throw new Error('No video frame is loaded.');
  const context = target.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable.');
  const cols = treatment.density;
  const rows = Math.max(1, Math.round(((cols * height) / width) * 0.55));
  const cellW = target.width / cols;
  const cellH = target.height / rows;
  if (!treatment.sourceColor) {
    context.fillStyle = treatment.background;
    context.fillRect(0, 0, target.width, target.height);
    context.fillStyle = treatment.foreground;
    context.font = `${cellH}px monospace`;
    context.textBaseline = 'top';
    const lines = extractCharacterRows(sample, treatment);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++)
        context.fillText(lines[y]![x]!, x * cellW, y * cellH);
    return;
  }
  const source = new OffscreenCanvas(cols, rows);
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('Canvas 2D is unavailable.');
  sample.draw(sourceContext, 0, 0, cols, rows);
  const pixels = sourceContext.getImageData(0, 0, cols, rows).data;
  context.fillStyle = treatment.background;
  context.fillRect(0, 0, target.width, target.height);
  context.font = `${cellH}px monospace`;
  context.textBaseline = 'top';
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const offset = (y * cols + x) * 4;
      let brightness =
        (pixels[offset] * 0.2126 +
          pixels[offset + 1] * 0.7152 +
          pixels[offset + 2] * 0.0722) /
        255;
      brightness =
        (brightness - 0.5) * (treatment.contrast / 100) +
        0.5 +
        treatment.brightness / 100;
      brightness = Math.max(0, Math.min(1, brightness));
      if (treatment.inverted) brightness = 1 - brightness;
      const ramp = ramps[treatment.preset];
      const char =
        treatment.preset === 'Binary' && brightness < 0.18
          ? ' '
          : ramp[
              Math.min(ramp.length - 1, Math.floor(brightness * ramp.length))
            ];
      context.fillStyle = treatment.sourceColor
        ? `rgb(${pixels[offset]}, ${pixels[offset + 1]}, ${pixels[offset + 2]})`
        : treatment.foreground;
      context.fillText(char, x * cellW, y * cellH);
    }
}

function extractCharacterRows(
  sample: Parameters<typeof drawAscii>[0],
  treatment: Treatment,
) {
  return extractCharacterGrid(sample, treatment).rows;
}

function extractCharacterGrid(
  sample: Parameters<typeof drawAscii>[0],
  treatment: Treatment,
) {
  const columns = treatment.density;
  const rows = Math.max(1, Math.round(((columns * height) / width) * 0.55));
  const source = new OffscreenCanvas(columns, rows);
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('Canvas 2D is unavailable.');
  sample.draw(sourceContext, 0, 0, columns, rows);
  const pixels = sourceContext.getImageData(0, 0, columns, rows).data;
  const ramp = ramps[treatment.preset];
  const output: string[] = [];
  const colors: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    let colorLine = '';
    for (let x = 0; x < columns; x++) {
      const offset = (y * columns + x) * 4;
      let brightness =
        (pixels[offset] * 0.2126 +
          pixels[offset + 1] * 0.7152 +
          pixels[offset + 2] * 0.0722) /
        255;
      brightness =
        (brightness - 0.5) * (treatment.contrast / 100) +
        0.5 +
        treatment.brightness / 100;
      brightness = Math.max(0, Math.min(1, brightness));
      if (treatment.inverted) brightness = 1 - brightness;
      line +=
        treatment.preset === 'Binary' && brightness < 0.18
          ? ' '
          : ramp[
              Math.min(ramp.length - 1, Math.floor(brightness * ramp.length))
            ];
      if (treatment.sourceColor) {
        const red = pixels[offset]!.toString(16).padStart(2, '0');
        const green = pixels[offset + 1]!.toString(16).padStart(2, '0');
        const blue = pixels[offset + 2]!.toString(16).padStart(2, '0');
        colorLine += red + green + blue;
      }
    }
    output.push(line);
    if (treatment.sourceColor) colors.push(colorLine);
  }
  return {
    rows: output,
    ...(treatment.sourceColor ? { colors } : {}),
  };
}

function outputDimensions(sourceWidth: number, sourceHeight: number) {
  const portrait = sourceHeight > sourceWidth;
  const maxWidth = portrait ? 720 : 1280;
  const maxHeight = portrait ? 1280 : 720;
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  // H.264 4:2:0 frames use even dimensions. Flooring avoids upscaling.
  return {
    width: Math.max(2, Math.floor((sourceWidth * scale) / 2) * 2),
    height: Math.max(2, Math.floor((sourceHeight * scale) / 2) * 2),
  };
}

async function load(sourceFile: File) {
  if (sourceFile.size > 100_000_000)
    throw new Error(
      'This source video is larger than 100 MB (100,000,000 bytes). Choose a smaller file.',
    );
  input?.dispose();
  input = undefined;
  sink = undefined;
  file = sourceFile;
  latestPreviewSequence = 0;
  input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(sourceFile),
  });
  let mime: string | null;
  try {
    mime = await input.getMimeType();
  } catch {
    throw new Error(
      'This file could not be read as a supported video. Choose an H.264 MP4.',
    );
  }
  if (!mime?.startsWith('video/mp4'))
    throw new Error(
      'This container is not supported. Choose an H.264 MP4 source video.',
    );
  track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('This MP4 has no video track.');
  if ((await track.getCodec()) !== 'avc')
    throw new Error(
      'This MP4 does not contain H.264 video. Choose an H.264 MP4 source video.',
    );
  width = track.displayWidth;
  height = track.displayHeight;
  duration = await input.computeDuration();
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error(
      'The video duration could not be read. Choose a readable H.264 MP4.',
    );
  if (duration >= 15)
    throw new Error(
      'This source video is 15 seconds or longer. Choose a shorter clip.',
    );
  const portrait = height > width;
  const maxWidth = portrait ? 1080 : 1920;
  const maxHeight = portrait ? 1920 : 1080;
  if (width > maxWidth || height > maxHeight)
    throw new Error(
      `This source video is larger than ${maxWidth} × ${maxHeight}. Choose a smaller video.`,
    );
  const frameRate = await track.computeFrameRateMetrics({
    targetPacketCount: 512,
  });
  if (frameRate.maxFrameRate > 60)
    throw new Error(
      'This source video exceeds 60 fps. Choose a video at 60 fps or less.',
    );
  sourceFrameRate = frameRate.bestGuessFrameRate || 30;
  if (!(await track.canDecode()))
    throw new Error(
      'This device cannot decode this H.264 source video. Try a supported H.264 MP4 in Chrome or Edge.',
    );
  sink = new VideoSampleSink(track);
  const dimensions = outputDimensions(width, height);
  canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
  const sample = await sink.getSample(await track.getFirstTimestamp());
  if (!sample) throw new Error('Could not decode the first video frame.');
  drawAscii(sample, canvas, defaultTreatment);
  sample.close();
  const bitmap = await createImageBitmap(canvas);
  scope.postMessage(
    { type: 'preview', bitmap, name: sourceFile.name, sequence: 0 },
    [bitmap],
  );
  scope.postMessage({
    type: 'ready',
    width: canvas.width,
    height: canvas.height,
    duration,
  });
}

async function renderPreview(
  timestamp: number,
  sequence: number,
  treatment: Treatment,
) {
  if (!sink || !canvas || !track) return;
  const firstTimestamp = await track.getFirstTimestamp();
  const boundedTimestamp = Math.min(Math.max(0, timestamp), duration - 0.001);
  const sample = await sink.getSample(firstTimestamp + boundedTimestamp);
  if (!sample) return;
  if (sequence !== latestPreviewSequence) {
    sample.close();
    return;
  }
  drawAscii(sample, canvas, treatment);
  sample.close();
  const bitmap = await createImageBitmap(canvas);
  if (sequence !== latestPreviewSequence) {
    bitmap.close();
    return;
  }
  scope.postMessage(
    { type: 'preview', bitmap, name: file?.name ?? '', sequence },
    [bitmap],
  );
}

async function processPreviewQueue() {
  if (processingPreview) return;
  processingPreview = true;
  try {
    while (pendingPreview) {
      const request = pendingPreview;
      pendingPreview = undefined;
      try {
        await renderPreview(
          request.timestamp,
          request.sequence,
          request.treatment,
        );
      } catch (error) {
        if (request.sequence !== latestPreviewSequence) continue;
        scope.postMessage({
          type: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Could not render preview.',
        });
      }
    }
  } finally {
    processingPreview = false;
    if (pendingPreview) void processPreviewQueue();
  }
}

async function exportMp4(treatment: Treatment) {
  if (!file || !input || !track || !sink || !canvas)
    throw new Error('Choose a source video first.');
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  activeOutput = output;
  exportCanceled = false;
  const exportCanvas = new OffscreenCanvas(canvas.width, canvas.height);
  const source = new CanvasSource(exportCanvas, {
    codec: 'avc',
    quality: new Quality('medium'),
  });
  output.addVideoTrack(source);
  await output.start();
  let count = 0;
  const frameRate = Math.min(30, sourceFrameRate);
  const step = 1 / frameRate;
  const firstTimestamp = await track.getFirstTimestamp();
  const frameCount = Math.ceil(duration * frameRate);
  try {
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      if (exportCanceled) return;
      const timestamp = frameIndex * step;
      if (timestamp >= duration) break;
      const sample = await sink.getSample(firstTimestamp + timestamp);
      if (exportCanceled) {
        sample?.close();
        return;
      }
      if (!sample)
        throw new Error(
          `Could not decode the required export frame at ${timestamp.toFixed(3)} seconds.`,
        );
      try {
        drawAscii(sample, exportCanvas, treatment);
      } finally {
        sample.close();
      }
      await source.add(timestamp, Math.min(step, duration - timestamp));
      count++;
      scope.postMessage({
        type: 'progress',
        value: Math.min(0.99, count / frameCount),
        completedFrames: count,
        totalFrames: frameCount,
      });
      if (testExportFailure && !didTestExportFail && count === 2) {
        didTestExportFail = true;
        throw new Error('Controlled export failure for recovery testing.');
      }
      if (testExportDelay > 0)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, testExportDelay),
        );
      else await yieldToWorkerMessages();
    }
    if (exportCanceled) return;
    source.close();
    await output.finalize();
    if (exportCanceled) return;
    if (!target.buffer) throw new Error('The MP4 encoder returned no output.');
    scope.postMessage({ type: 'done', bytes: target.buffer }, [target.buffer]);
  } catch (error) {
    if (exportCanceled) return;
    if (output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel();
    }
    throw error;
  } finally {
    source.close();
    if (activeOutput === output) activeOutput = undefined;
    if (exportCanceled) {
      exportCanceled = false;
      scope.postMessage({ type: 'canceled' });
    }
  }
}

async function exportCodeBundle(treatment: Treatment) {
  if (!file || !track || !sink || !canvas)
    throw new Error('Choose a source video first.');
  if (
    !/^#[\da-f]{6}$/i.test(treatment.foreground) ||
    !/^#[\da-f]{6}$/i.test(treatment.background)
  )
    throw new Error('Choose valid foreground and background colors.');
  const columns = treatment.density;
  const rows = Math.max(1, Math.round(((columns * height) / width) * 0.55));
  const cellWidth = canvas.width / columns;
  const cellHeight = canvas.height / rows;
  const frameRate = Math.min(30, sourceFrameRate);
  const step = 1 / frameRate;
  const frameCount = Math.ceil(duration * frameRate);
  if (frameCount > 450 || columns * rows * frameCount > 7_200_000)
    throw new Error('This ASCII bundle would exceed the safe data limit.');
  const cells = columns * rows * frameCount;
  const estimatedDataCharacters =
    2_000 +
    frameCount * (160 + rows * 6) +
    cells * (treatment.sourceColor ? 7 : 1);
  if (estimatedDataCharacters > 5_000_000)
    throw new Error('This ASCII bundle would exceed the 5 MB data limit.');
  const firstTimestamp = await track.getFirstTimestamp();
  const frames: Array<{
    timestamp: number;
    duration: number;
    rows: string[];
    colors?: string[];
  }> = [];
  let estimatedCharactersUsed = 2_000 + frameCount * 160;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const timestamp = frameIndex * step;
    if (timestamp >= duration) break;
    const frameEstimate =
      columns * rows * (treatment.sourceColor ? 7 : 1) + rows * 6;
    if (estimatedCharactersUsed + frameEstimate > 5_000_000)
      throw new Error('This ASCII bundle would exceed the 5 MB data limit.');
    const sample = await sink.getSample(firstTimestamp + timestamp);
    if (!sample)
      throw new Error(
        `Could not decode the frame at ${timestamp.toFixed(3)} seconds.`,
      );
    try {
      const grid = extractCharacterGrid(sample, treatment);
      frames.push({
        timestamp,
        duration: Math.min(step, duration - timestamp),
        rows: grid.rows,
        ...(grid.colors ? { colors: grid.colors } : {}),
      });
      estimatedCharactersUsed += frameEstimate;
    } finally {
      sample.close();
    }
    await yieldToWorkerMessages();
  }
  const data = {
    version: 1,
    width: canvas.width,
    height: canvas.height,
    columns,
    rows,
    cellWidth,
    cellHeight,
    fontSize: cellHeight,
    foreground: treatment.foreground,
    background: treatment.background,
    duration,
    frames,
  };
  const dataJson = JSON.stringify(data);
  if (dataJson.length > 5_000_000)
    throw new Error('This ASCII bundle would exceed the 5 MB data limit.');
  const readme =
    'ASCII video bundle\n\nOpen index.html directly in a desktop browser. It works offline, starts paused, and includes labeled Play/Pause and Loop controls.\n\nFiles: index.html is the runnable example; player.js is the reusable public player; data.json contains versioned row-major character frames. The player has no editor, source-video, build-tool, runtime-library, or external-font dependency.\n\nSeparate application setup: copy player.js and data.json into your app, load player.js with a script tag, fetch or import data.json, find a container element, then call AsciiVideoPlayer.mount({container, data}). mount creates its own frame and labeled controls, so the bundled example markup is not required. The returned instance provides play(), pause(), seek(seconds), setLoop(enabled), getCurrentTime(), element, and dispose(). seek accepts seconds from 0 through the recorded duration; at the duration boundary it displays the final frame. setLoop controls whether playback wraps at the recorded duration. options.loop defaults to true.\n\nSizing: the frame scales down to fit the container width while preserving source aspect ratio and cell proportions. It never enlarges beyond its generated dimensions. Resizing changes presentation size; data rows, columns, and logical cell geometry remain unchanged.\n\nAutoplay is off by default. To opt in, pass autoplay: true; the player suppresses this unsolicited playback when prefers-reduced-motion is reduce. The user can still start deliberate playback. dispose() stops its animation frame, disconnects its resize observer, removes its event listener, and removes the mounted player element. Call it when removing the player.\n\nData compatibility: version 1 supports fixed-color frames (rows only, using foreground) and source-color frames (rows plus six-digit RGB colors per cell). The background color is independent in both modes. The output uses the browser monospace system font, so glyph shape and spacing can differ across systems.\n';
  const zip = createZip([
    { name: 'index.html', content: createExampleHtml(data) },
    { name: 'player.js', content: playerJavaScript },
    { name: 'data.json', content: dataJson },
    { name: 'README.txt', content: readme },
  ]);
  if (zip.size > 12_000_000)
    throw new Error('This ASCII bundle would exceed the 12 MB bundle limit.');
  const bytes = await zip.arrayBuffer();
  scope.postMessage({ type: 'code-bundle-done', bytes }, [bytes]);
}

scope.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.type === 'dispose') {
    exportCanceled = true;
    void activeOutput?.cancel();
    input?.dispose();
    input = undefined;
    sink = undefined;
    track = null;
    file = undefined;
    canvas = undefined;
    pendingPreview = undefined;
    scope.postMessage({ type: 'disposed' });
    return;
  }
  if (request.type === 'load') {
    testExportDelay = import.meta.env.DEV ? (request.testExportDelay ?? 0) : 0;
    testExportFailure =
      import.meta.env.DEV && request.testExportFailure === true;
  }
  if (request.type === 'cancel-export') {
    exportCanceled = true;
    void activeOutput?.cancel();
    return;
  }
  if (request.type === 'preview') {
    latestPreviewSequence = request.sequence;
    pendingPreview = request;
    void processPreviewQueue();
    return;
  }
  const task =
    request.type === 'load'
      ? load(request.file)
      : request.type === 'export'
        ? exportMp4(request.treatment)
        : request.type === 'code-bundle'
          ? exportCodeBundle(request.treatment)
          : Promise.resolve();
  task.catch((error: unknown) => {
    if (request.type === 'load') {
      input?.dispose();
      input = undefined;
      track = null;
      sink = undefined;
      file = undefined;
      canvas = undefined;
    }
    scope.postMessage({
      type: 'error',
      message:
        error instanceof Error ? error.message : 'Video processing failed.',
    });
  });
};
