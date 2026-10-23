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

type Request =
  | {
      type: 'load';
      file: File;
      treatment: Treatment;
      testExportFailure?: boolean;
      testExportDelay?: number;
    }
  | {
      type: 'preview';
      timestamp: number;
      sequence: number;
      treatment: Treatment;
    }
  | { type: 'export'; treatment: Treatment; operationId: number }
  | { type: 'cancel-export'; operationId: number }
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
  mode: 'ASCII',
  density: 88,
  gridStep: 8,
  spacing: 25,
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
let canceledExportId: number | undefined;
let activeOutput: Output | undefined;
let activeExportId: number | undefined;
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

function drawPixelated(
  sample: {
    draw: (
      context: OffscreenCanvasRenderingContext2D,
      x: number,
      y: number,
      width?: number,
      height?: number,
    ) => void;
  },
  target: OffscreenCanvas,
  treatment: Treatment,
) {
  const context = target.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable.');
  const source = new OffscreenCanvas(target.width, target.height);
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('Canvas 2D is unavailable.');
  sample.draw(sourceContext, 0, 0, target.width, target.height);
  const { data } = sourceContext.getImageData(
    0,
    0,
    target.width,
    target.height,
  );
  context.fillStyle = treatment.background;
  context.fillRect(0, 0, target.width, target.height);
  context.fillStyle = treatment.foreground;
  const step = treatment.gridStep;
  const spacing = Math.max(0, Math.min(0.8, treatment.spacing / 100));
  const maxCellSide = step * (1 - spacing);
  const columns = Math.max(1, Math.round(target.width / step));
  const rows = Math.max(1, Math.round(target.height / step));
  const centerX = (columns - 1) / 2;
  const centerY = (rows - 1) / 2;
  for (let row = 0; row < rows; row++) {
    const y = target.height / 2 + (row - centerY) * step;
    for (let column = 0; column < columns; column++) {
      const x = target.width / 2 + (column - centerX) * step;
      const left = Math.max(0, Math.floor(x - step / 2));
      const top = Math.max(0, Math.floor(y - step / 2));
      const right = Math.min(target.width, Math.ceil(x + step / 2));
      const bottom = Math.min(target.height, Math.ceil(y + step / 2));
      let red = 0;
      let green = 0;
      let blue = 0;
      let pixels = 0;
      for (let py = top; py < bottom; py++)
        for (let px = left; px < right; px++) {
          const offset = (py * target.width + px) * 4;
          red += data[offset];
          green += data[offset + 1];
          blue += data[offset + 2];
          pixels++;
        }
      if (!pixels) continue;
      red /= pixels;
      green /= pixels;
      blue /= pixels;
      let brightness = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
      brightness = Math.max(
        0,
        Math.min(
          1,
          (brightness - 0.5) * (treatment.contrast / 100) +
            0.5 +
            treatment.brightness / 100,
        ),
      );
      if (treatment.inverted) brightness = 1 - brightness;
      const side = maxCellSide * brightness;
      if (side <= 0) continue;
      context.fillStyle = treatment.foreground;
      context.fillRect(x - side / 2, y - side / 2, side, side);
    }
  }
}

function drawFrame(
  sample: Parameters<typeof drawAscii>[0],
  target: OffscreenCanvas,
  treatment: Treatment,
) {
  if (treatment.mode === 'Pixelated') drawPixelated(sample, target, treatment);
  else drawAscii(sample, target, treatment);
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

async function load(sourceFile: File, treatment: Treatment) {
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
  drawFrame(sample, canvas, treatment);
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
  drawFrame(sample, canvas, treatment);
  sample.close();
  const bitmap = await createImageBitmap(canvas);
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
          sequence: request.sequence,
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

async function exportMp4(treatment: Treatment, operationId: number) {
  if (!file || !input || !track || !sink || !canvas)
    throw new Error('Choose a source video first.');
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  activeOutput = output;
  activeExportId = operationId;
  canceledExportId = undefined;
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
      if (canceledExportId === operationId) return;
      const timestamp = frameIndex * step;
      if (timestamp >= duration) break;
      const sample = await sink.getSample(firstTimestamp + timestamp);
      if (canceledExportId === operationId) {
        sample?.close();
        return;
      }
      if (!sample)
        throw new Error(
          `Could not decode the required export frame at ${timestamp.toFixed(3)} seconds.`,
        );
      try {
        drawFrame(sample, exportCanvas, treatment);
      } finally {
        sample.close();
      }
      await source.add(timestamp, Math.min(step, duration - timestamp));
      count++;
      scope.postMessage({
        type: 'progress',
        operationId,
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
    if (canceledExportId === operationId) return;
    source.close();
    await output.finalize();
    if (canceledExportId === operationId) return;
    if (!target.buffer) throw new Error('The MP4 encoder returned no output.');
    scope.postMessage({ type: 'done', operationId, bytes: target.buffer }, [
      target.buffer,
    ]);
  } catch (error) {
    if (canceledExportId === operationId) return;
    if (output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel();
    }
    throw error;
  } finally {
    source.close();
    if (activeOutput === output) activeOutput = undefined;
    if (activeExportId === operationId) activeExportId = undefined;
    if (canceledExportId === operationId) {
      canceledExportId = undefined;
      scope.postMessage({ type: 'canceled', operationId });
    }
  }
}

scope.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.type === 'dispose') {
    canceledExportId = activeExportId;
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
    if (activeExportId !== request.operationId) return;
    canceledExportId = request.operationId;
    void activeOutput?.cancel();
    return;
  }
  if (request.type === 'preview') {
    latestPreviewSequence = request.sequence;
    pendingPreview = request;
    void processPreviewQueue();
    return;
  }
  if (request.type === 'export' && activeExportId !== undefined) return;
  const task =
    request.type === 'load'
      ? load(request.file, request.treatment)
      : request.type === 'export'
        ? exportMp4(request.treatment, request.operationId)
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
      ...(request.type === 'export'
        ? { operationId: request.operationId }
        : {}),
      message:
        error instanceof Error ? error.message : 'Video processing failed.',
    });
  });
};
