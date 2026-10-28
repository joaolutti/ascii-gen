import {
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSample,
  VideoSampleSink,
  ALL_FORMATS,
} from 'mediabunny';
import type { Treatment } from './treatment';
import { createAsciiFrame, paintAsciiFrame } from './asciiFrame';
import {
  codeBundleLimits,
  createExampleHtml,
  createZip,
  playerJavaScript,
} from './codeBundle';

type Request =
  | {
      type: 'load';
      file: File;
      previewDiagnostics?: boolean;
      testExportFailure?: boolean;
      testExportDelay?: number;
      testCodeBundleFailure?: boolean;
      testCodeBundleDelay?: number;
      testCodeBundleLimitAfterFrames?: number;
    }
  | {
      type: 'preview';
      timestamp: number;
      sequence: number;
      generationId: number;
      treatment: Treatment;
    }
  | { type: 'export'; treatment: Treatment; operationId: number }
  | { type: 'code-bundle'; treatment: Treatment; operationId: number }
  | { type: 'cancel-export'; operationId: number }
  | { type: 'cancel-code-bundle'; operationId: number }
  | { type: 'dispose' };
const scope = self as DedicatedWorkerGlobalScope;
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
let firstTimestamp = 0;
let sourceFrameRate = 30;
let latestPreviewSequence = 0;
let input: Input | undefined;
let track: Awaited<ReturnType<Input['getPrimaryVideoTrack']>>;
let sink: VideoSampleSink | undefined;
let canvas: OffscreenCanvas | undefined;
let previewSamplingCanvas: OffscreenCanvas | undefined;
let pendingPreview:
  | {
      timestamp: number;
      sequence: number;
      generationId: number;
      treatment: Treatment;
    }
  | undefined;
let processingPreview = false;
let previewSamples: ReturnType<VideoSampleSink['samples']> | undefined;
let previewCurrentSample: VideoSample | undefined;
let previewNextSample: VideoSample | undefined;
let previewDiagnosticsEnabled = false;
let replacedPendingPreviewCount = 0;
let activeExportId: number | undefined;
let canceledExportId: number | undefined;
let activeOutput: Output | undefined;
let didTestExportFail = false;

let testExportDelay = 0;
let testExportFailure = false;
let testCodeBundleDelay = 0;
let testCodeBundleFailure = false;
let testCodeBundleLimitAfterFrames = 0;
let didTestCodeBundleLimitFailure = false;
let didTestCodeBundleFail = false;
let activeCodeBundleId: number | undefined;
let canceledCodeBundleId: number | undefined;
let activeCodeBundleFrames:
  | Array<{
      timestamp: number;
      duration: number;
      rows: string[];
      colors?: string[];
    }>
  | undefined;

const oversizedCodeBundleMessage =
  'This ASCII bundle exceeds the safe export limits. Lower Density in the editor and generate it again; duration, frame rate, and color fidelity are never reduced automatically.';

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
  const columns = treatment.density;
  const rows = Math.max(
    1,
    Math.round(((columns * height) / width) * 0.55),
  );
  previewSamplingCanvas ??= new OffscreenCanvas(columns, rows);
  const frame = createAsciiFrame(sample, { width, height }, treatment, {
    width: target.width,
    height: target.height,
  }, previewSamplingCanvas);
  paintAsciiFrame(frame, target, treatment);
}

function drawFrame(
  sample: Parameters<typeof drawAscii>[0],
  target: OffscreenCanvas,
  treatment: Treatment,
) {
  if (treatment.mode === 'ASCII') {
    drawAscii(sample, target, treatment);
    return;
  }
  const context = target.getContext('2d');
  const source = new OffscreenCanvas(target.width, target.height);
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!context || !sourceContext) throw new Error('Canvas 2D is unavailable.');
  sample.draw(sourceContext, 0, 0, target.width, target.height);
  const pixels = sourceContext.getImageData(
    0,
    0,
    target.width,
    target.height,
  ).data;
  context.fillStyle = treatment.background;
  context.fillRect(0, 0, target.width, target.height);
  const step = Math.max(1, treatment.gridStep);
  const spacing = Math.max(0, Math.min(0.8, treatment.spacing / 100));
  const columns = Math.max(1, Math.round(target.width / step));
  const rows = Math.max(1, Math.round(target.height / step));
  const glowBlur = step * 0.9;
  const highlightThreshold = 0.82;
  const coreThreshold = 0.91;
  for (let row = 0; row < rows; row++) {
    const y = target.height / 2 + (row - (rows - 1) / 2) * step;
    for (let column = 0; column < columns; column++) {
      const x = target.width / 2 + (column - (columns - 1) / 2) * step;
      const left = Math.max(0, Math.floor(x - step / 2));
      const top = Math.max(0, Math.floor(y - step / 2));
      const right = Math.min(target.width, Math.ceil(x + step / 2));
      const bottom = Math.min(target.height, Math.ceil(y + step / 2));
      let luminance = 0;
      let count = 0;
      for (let py = top; py < bottom; py++) {
        for (let px = left; px < right; px++) {
          const offset = (py * target.width + px) * 4;
          luminance +=
            pixels[offset]! * 0.2126 +
            pixels[offset + 1]! * 0.7152 +
            pixels[offset + 2]! * 0.0722;
          count++;
        }
      }
      if (!count) continue;
      let brightness = luminance / count / 255;
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
      const side = step * (1 - spacing) * brightness;
      if (side > 0) {
        const isHighlight = brightness >= highlightThreshold;
        context.shadowColor = isHighlight
          ? treatment.foreground
          : 'transparent';
        context.shadowBlur = isHighlight ? glowBlur : 0;
        context.fillStyle = treatment.foreground;
        context.fillRect(x - side / 2, y - side / 2, side, side);
        if (brightness >= coreThreshold) {
          context.shadowBlur = 0;
          context.fillStyle = '#fff0c2';
          const coreSide = Math.max(1, side * 0.28);
          context.fillRect(
            x - coreSide / 2,
            y - coreSide / 2,
            coreSide,
            coreSide,
          );
        }
      }
    }
  }
  context.shadowBlur = 0;
  context.shadowColor = 'transparent';
}

function closePreviewSamples() {
  previewCurrentSample?.close();
  previewNextSample?.close();
  previewCurrentSample = undefined;
  previewNextSample = undefined;
  const iterator = previewSamples;
  previewSamples = undefined;
  if (iterator) void iterator.return(undefined);
}

function startPreviewSamples(timestamp: number) {
  closePreviewSamples();
  if (!sink) return;
  previewSamples = sink.samples(timestamp);
}

async function getPreviewSample(timestamp: number) {
  if (!sink) return null;
  const absoluteTimestamp =
    firstTimestamp + Math.min(Math.max(0, timestamp), duration - 0.001);
  if (
    previewCurrentSample &&
    absoluteTimestamp + 1e-6 < previewCurrentSample.timestamp
  ) {
    startPreviewSamples(absoluteTimestamp);
  } else if (!previewSamples) {
    startPreviewSamples(absoluteTimestamp);
  }

  if (
    previewNextSample &&
    previewNextSample.timestamp <= absoluteTimestamp + 1e-6
  ) {
    previewCurrentSample?.close();
    previewCurrentSample = previewNextSample;
    previewNextSample = undefined;
  }

  while (previewSamples && !previewNextSample) {
    const next = await previewSamples.next();
    if (next.done) {
      previewSamples = undefined;
      break;
    }
    if (next.value.timestamp <= absoluteTimestamp + 1e-6) {
      previewCurrentSample?.close();
      previewCurrentSample = next.value;
    } else {
      previewNextSample = next.value;
    }
  }

  return (previewCurrentSample ?? previewNextSample)?.clone() ?? null;
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
  closePreviewSamples();
  input?.dispose();
  input = undefined;
  sink = undefined;
  file = sourceFile;
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
  firstTimestamp = await track.getFirstTimestamp();
  const sample = await sink.getSample(firstTimestamp);
  if (!sample) throw new Error('Could not decode the first video frame.');
  drawFrame(sample, canvas, defaultTreatment);
  sample.close();
  const bitmap = await createImageBitmap(canvas);
  scope.postMessage(
    {
      type: 'preview',
      bitmap,
      name: sourceFile.name,
      sequence: 0,
      generationId: 0,
    },
    [bitmap],
  );
  scope.postMessage({
    type: 'ready',
    width: canvas.width,
    height: canvas.height,
    duration,
    frameRate: sourceFrameRate,
  });
}

async function renderPreview(
  timestamp: number,
  sequence: number,
  generationId: number,
  treatment: Treatment,
) {
  if (!sink || !canvas || !track) return;
  const workerStartedAt = previewDiagnosticsEnabled ? performance.now() : 0;
  const sampleStartedAt = workerStartedAt;
  const sample = await getPreviewSample(timestamp);
  if (!sample) return;
  const sampleLookupDecodeMs = previewDiagnosticsEnabled
    ? performance.now() - sampleStartedAt
    : 0;
  const drawStartedAt = previewDiagnosticsEnabled ? performance.now() : 0;
  drawFrame(sample, canvas, treatment);
  sample.close();
  const drawFrameMs = previewDiagnosticsEnabled
    ? performance.now() - drawStartedAt
    : 0;
  const bitmapStartedAt = previewDiagnosticsEnabled ? performance.now() : 0;
  const bitmap = await createImageBitmap(canvas);
  const bitmapCreationMs = previewDiagnosticsEnabled
    ? performance.now() - bitmapStartedAt
    : 0;
  const diagnostics = previewDiagnosticsEnabled
    ? {
        sampleLookupDecodeMs,
        drawFrameMs,
        bitmapCreationMs,
        workerTotalMs: performance.now() - workerStartedAt,
        replacedPendingPreviewCount,
      }
    : undefined;
  scope.postMessage(
    {
      type: 'preview',
      bitmap,
      name: file?.name ?? '',
      sequence,
      generationId,
      ...(diagnostics ? { diagnostics } : {}),
    },
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
          request.generationId,
          request.treatment,
        );
      } catch (error) {
        if (request.sequence !== latestPreviewSequence) continue;
        scope.postMessage({
          type: 'error',
          generationId: request.generationId,
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
  const isCanceled = () => canceledExportId === operationId;
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
      if (isCanceled()) return;
      const timestamp = frameIndex * step;
      if (timestamp >= duration) break;
      const sample = await sink.getSample(firstTimestamp + timestamp);
      if (isCanceled()) {
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
    if (isCanceled()) return;
    source.close();
    await output.finalize();
    if (isCanceled()) return;
    if (!target.buffer) throw new Error('The MP4 encoder returned no output.');
    scope.postMessage({ type: 'done', operationId, bytes: target.buffer }, [
      target.buffer,
    ]);
  } catch (error) {
    if (isCanceled()) return;
    if (output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel();
    }
    throw error;
  } finally {
    source.close();
    if (activeOutput === output) activeOutput = undefined;
    if (activeExportId === operationId) activeExportId = undefined;
    if (isCanceled()) {
      canceledExportId = undefined;
      scope.postMessage({ type: 'canceled', operationId });
    }
  }
}

async function exportCodeBundle(treatment: Treatment, operationId: number) {
  if (activeCodeBundleId !== undefined)
    throw new Error('Another ASCII bundle generation is already active.');
  activeCodeBundleId = operationId;
  canceledCodeBundleId = undefined;
  const isCanceled = () => canceledCodeBundleId === operationId;
  const finishCanceled = () => {
    if (activeCodeBundleId === operationId) {
      if (activeCodeBundleFrames) activeCodeBundleFrames.length = 0;
      activeCodeBundleFrames = undefined;
    }
    if (activeCodeBundleId === operationId) activeCodeBundleId = undefined;
    scope.postMessage({ type: 'code-bundle-canceled', operationId });
  };
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
  const cellsPerFrame = columns * rows;
  const cells = cellsPerFrame * frameCount;
  // JSON escaping can double the character payload; RGB cells add six hex
  // digits. The decoded-data estimate accounts for UTF-16 strings and row /
  // frame arrays retained while the package is assembled.
  const jsonBytesPerCell = treatment.sourceColor ? 8 : 2;
  const decodedBytesPerCell = treatment.sourceColor ? 14 : 2;
  const estimatedJsonBytes =
    2_000 + frameCount * (200 + rows * 6) + cells * jsonBytesPerCell;
  const estimatedDecodedBytes =
    cells * decodedBytesPerCell + frameCount * (rows * 32 + 256);
  if (
    frameCount > codeBundleLimits.maxFrames ||
    cellsPerFrame > codeBundleLimits.maxCellsPerFrame ||
    cells > codeBundleLimits.maxTotalCells ||
    estimatedJsonBytes > codeBundleLimits.maxJsonBytes ||
    estimatedDecodedBytes > codeBundleLimits.maxDecodedFrameDataBytes
  )
    throw new Error(oversizedCodeBundleMessage);
  const firstTimestamp = await track.getFirstTimestamp();
  const frames: Array<{
    timestamp: number;
    duration: number;
    rows: string[];
    colors?: string[];
  }> = [];
  activeCodeBundleFrames = frames;
  let estimatedJsonBytesUsed = 2_000 + frameCount * 200;
  let generatedCells = 0;
  let estimatedDecodedBytesUsed = 0;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    if (isCanceled()) {
      finishCanceled();
      return;
    }
    const timestamp = frameIndex * step;
    if (timestamp >= duration) break;
    const frameCells = columns * rows;
    const frameJsonEstimate = frameCells * jsonBytesPerCell + rows * 6 + 200;
    const frameDecodedEstimate =
      frameCells * decodedBytesPerCell + rows * 32 + 256;
    if (
      frameCells > codeBundleLimits.maxCellsPerFrame ||
      generatedCells + frameCells > codeBundleLimits.maxTotalCells ||
      estimatedJsonBytesUsed + frameJsonEstimate >
        codeBundleLimits.maxJsonBytes ||
      estimatedDecodedBytesUsed + frameDecodedEstimate >
        codeBundleLimits.maxDecodedFrameDataBytes
    )
      throw new Error(oversizedCodeBundleMessage);
    const sample = await sink.getSample(firstTimestamp + timestamp);
    if (!sample)
      throw new Error(
        `Could not decode the frame at ${timestamp.toFixed(3)} seconds.`,
      );
    try {
      const grid = createAsciiFrame(sample, { width, height }, treatment, {
        width: canvas.width,
        height: canvas.height,
      });
      frames.push({
        timestamp,
        duration: Math.min(step, duration - timestamp),
        rows: grid.characters,
        ...(grid.colors ? { colors: grid.colors } : {}),
      });
      generatedCells += frameCells;
      estimatedJsonBytesUsed += frameJsonEstimate;
      estimatedDecodedBytesUsed += frameDecodedEstimate;
    } finally {
      sample.close();
    }
    scope.postMessage({
      type: 'code-bundle-progress',
      operationId,
      value: Math.min(0.95, (frameIndex + 1) / frameCount),
      completedFrames: frameIndex + 1,
      totalFrames: frameCount,
    });
    if (testCodeBundleFailure && !didTestCodeBundleFail && frameIndex === 1) {
      didTestCodeBundleFail = true;
      throw new Error('Controlled ASCII bundle failure for recovery testing.');
    }
    if (
      testCodeBundleLimitAfterFrames > 0 &&
      !didTestCodeBundleLimitFailure &&
      frameIndex + 1 >= testCodeBundleLimitAfterFrames
    ) {
      didTestCodeBundleLimitFailure = true;
      frames.length = 0;
      throw new Error(oversizedCodeBundleMessage);
    }
    if (testCodeBundleDelay > 0)
      await new Promise<void>((resolve) =>
        setTimeout(resolve, testCodeBundleDelay),
      );
    else await yieldToWorkerMessages();
    if (isCanceled()) {
      finishCanceled();
      return;
    }
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
  if (
    new TextEncoder().encode(dataJson).byteLength >
    codeBundleLimits.maxJsonBytes
  )
    throw new Error(oversizedCodeBundleMessage);
  const readme =
    'ASCII video bundle\n\nOpen index.html directly in a desktop browser. It works offline, starts paused, and includes labeled Play/Pause and Loop controls.\n\nFiles: index.html is the runnable example; player.js is the reusable public player; data.json contains versioned row-major character frames. The player has no editor, source-video, build-tool, runtime-library, or external-font dependency.\n\nSeparate application setup: copy player.js and data.json into your app, load player.js with a script tag, fetch or import data.json, find a container element, then call AsciiVideoPlayer.mount({container, data}). mount creates its own frame and labeled controls, so the bundled example markup is not required. The returned instance provides play(), pause(), seek(seconds), setLoop(enabled), getCurrentTime(), element, and dispose(). seek accepts seconds from 0 through the recorded duration; at the duration boundary it displays the final frame. setLoop controls whether playback wraps at the recorded duration. options.loop defaults to true.\n\nSizing: the frame scales down to fit the container width while preserving source aspect ratio and cell proportions. It never enlarges beyond its generated dimensions. Resizing changes presentation size; data rows, columns, and logical cell geometry remain unchanged.\n\nAutoplay is off by default. To opt in, pass autoplay: true; the player suppresses this unsolicited playback when prefers-reduced-motion is reduce. The user can still start deliberate playback. dispose() stops its animation frame, disconnects its resize observer, removes its event listener, and removes the mounted player element. Call it when removing the player.\n\nData compatibility: version 1 supports fixed-color frames (rows only, using foreground) and source-color frames (rows plus six-digit RGB colors per cell). The background color is independent in both modes. The output uses the browser monospace system font, so glyph shape and spacing can differ across systems.\n\nLimits: at most 28,000 cells in one frame, 7,200,000 cells total, 450 frames, 5,000,000 bytes of data.json, a 32,000,000-byte decoded-data estimate, and a 12,000,000-byte ZIP. Oversized work is rejected with lower-Density guidance; the generator never changes Density, cadence, duration, or color fidelity automatically.\n\nCapability separation: code generation requires supported H.264 decoding and raw DEFLATE ZIP support. It does not require H.264 MP4 encoding. The source video is not included in this archive.\n';
  const indexHtml = createExampleHtml(data);
  // All generated content is ASCII. String length is therefore a safe
  // preflight upper bound on UTF-8 bytes before ZIP buffers are allocated.
  const estimatedBundleBytes =
    indexHtml.length +
    dataJson.length +
    playerJavaScript.length +
    readme.length +
    512;
  if (estimatedBundleBytes > codeBundleLimits.maxBundleBytes)
    throw new Error(oversizedCodeBundleMessage);
  const zip = await createZip([
    { name: 'index.html', content: indexHtml },
    { name: 'player.js', content: playerJavaScript },
    { name: 'data.json', content: dataJson },
    { name: 'README.txt', content: readme },
  ]);
  if (zip.size > codeBundleLimits.maxBundleBytes)
    throw new Error(oversizedCodeBundleMessage);
  if (isCanceled()) {
    finishCanceled();
    return;
  }
  const bytes = await zip.arrayBuffer();
  if (isCanceled()) {
    finishCanceled();
    return;
  }
  scope.postMessage({ type: 'code-bundle-done', operationId, bytes }, [bytes]);
  if (activeCodeBundleId === operationId) activeCodeBundleFrames = undefined;
  if (activeCodeBundleId === operationId) activeCodeBundleId = undefined;
}

scope.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.type === 'dispose') {
    if (activeExportId !== undefined) canceledExportId = activeExportId;
    if (activeCodeBundleId !== undefined)
      canceledCodeBundleId = activeCodeBundleId;
    void activeOutput?.cancel();
    closePreviewSamples();
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
    testCodeBundleDelay = import.meta.env.DEV
      ? (request.testCodeBundleDelay ?? 0)
      : 0;
    testCodeBundleFailure =
      import.meta.env.DEV && request.testCodeBundleFailure === true;
    testCodeBundleLimitAfterFrames = import.meta.env.DEV
      ? Math.max(0, Math.floor(request.testCodeBundleLimitAfterFrames ?? 0))
      : 0;
  }
  if (request.type === 'cancel-export') {
    if (activeExportId !== request.operationId) return;
    canceledExportId = request.operationId;
    void activeOutput?.cancel();
    return;
  }
  if (request.type === 'cancel-code-bundle') {
    if (activeCodeBundleId === request.operationId) {
      canceledCodeBundleId = request.operationId;
    }
    return;
  }
  if (request.type === 'preview') {
    latestPreviewSequence = request.sequence;
    if (pendingPreview) replacedPendingPreviewCount++;
    pendingPreview = request;
    void processPreviewQueue();
    return;
  }
  if (request.type === 'load') {
    previewDiagnosticsEnabled = request.previewDiagnostics === true;
    replacedPendingPreviewCount = 0;
  }
  const task =
    request.type === 'load'
      ? load(request.file)
      : request.type === 'export'
        ? exportMp4(request.treatment, request.operationId)
        : request.type === 'code-bundle'
          ? exportCodeBundle(request.treatment, request.operationId)
          : Promise.resolve();
  task.catch((error: unknown) => {
    if (request.type === 'export' && activeExportId === request.operationId)
      activeExportId = undefined;
    if (request.type === 'code-bundle') {
      if (activeCodeBundleId === request.operationId)
        activeCodeBundleId = undefined;
      if (activeCodeBundleFrames) activeCodeBundleFrames.length = 0;
      activeCodeBundleFrames = undefined;
      if (canceledCodeBundleId === request.operationId) return;
    }
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
      ...(request.type === 'code-bundle' || request.type === 'export'
        ? { operationId: request.operationId }
        : {}),
      message:
        error instanceof Error ? error.message : 'Video processing failed.',
    });
  });
};
