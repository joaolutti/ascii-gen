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

type Request = { type: 'load'; file: File } | { type: 'export' };
const scope = self as DedicatedWorkerGlobalScope;
const chars =
  ' .\'`^",:;Il!i~+_-?][}{1)(|\\/*tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
let file: File | undefined;
let width = 0;
let height = 0;
let duration = 0;
let sourceFrameRate = 30;
let input: Input | undefined;
let track: Awaited<ReturnType<Input['getPrimaryVideoTrack']>>;
let sink: VideoSampleSink | undefined;
let canvas: OffscreenCanvas | undefined;

function drawAscii(sample: {
  draw: (
    context: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    width?: number,
    height?: number,
  ) => void;
}) {
  if (!canvas) throw new Error('No video frame is loaded.');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable.');
  const cols = 88;
  const rows = Math.max(1, Math.round(((cols * height) / width) * 0.55));
  const cellW = canvas.width / cols;
  const cellH = canvas.height / rows;
  const source = new OffscreenCanvas(cols, rows);
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('Canvas 2D is unavailable.');
  sample.draw(sourceContext, 0, 0, cols, rows);
  const pixels = sourceContext.getImageData(0, 0, cols, rows).data;
  context.fillStyle = '#111111';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.font = `${cellH}px monospace`;
  context.textBaseline = 'top';
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const offset = (y * cols + x) * 4;
      const brightness =
        (pixels[offset] * 0.2126 +
          pixels[offset + 1] * 0.7152 +
          pixels[offset + 2] * 0.0722) /
        255;
      const char =
        chars[
          Math.min(chars.length - 1, Math.floor(brightness * chars.length))
        ];
      context.fillText(char, x * cellW, y * cellH);
    }
}

async function load(sourceFile: File) {
  if (sourceFile.size > 100_000_000)
    throw new Error(
      'This source video is larger than 100 MB (100,000,000 bytes). Choose a smaller file.',
    );
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
  canvas = new OffscreenCanvas(width, height);
  const sample = await sink.getSample(await track.getFirstTimestamp());
  if (!sample) throw new Error('Could not decode the first video frame.');
  drawAscii(sample);
  sample.close();
  const bitmap = await createImageBitmap(canvas);
  scope.postMessage({ type: 'preview', bitmap, name: sourceFile.name }, [
    bitmap,
  ]);
  scope.postMessage({
    type: 'ready',
    width: canvas.width,
    height: canvas.height,
  });
}

async function exportMp4() {
  if (!file || !input || !track || !sink || !canvas)
    throw new Error('Choose a source video first.');
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    quality: new Quality('medium'),
  });
  output.addVideoTrack(source);
  await output.start();
  let count = 0;
  const frameRate = Math.min(30, sourceFrameRate);
  const step = 1 / frameRate;
  for (let timestamp = 0; timestamp < duration; timestamp += step) {
    const sample = await sink.getSample(timestamp);
    if (!sample) continue;
    drawAscii(sample);
    sample.close();
    await source.add(timestamp, Math.min(step, duration - timestamp));
    count++;
    if (count % 4 === 0)
      scope.postMessage({
        type: 'progress',
        value: Math.min(0.99, timestamp / duration),
      });
  }
  source.close();
  await output.finalize();
  if (!target.buffer) throw new Error('The MP4 encoder returned no output.');
  scope.postMessage({ type: 'done', bytes: target.buffer }, [target.buffer]);
}

scope.onmessage = (event: MessageEvent<Request>) => {
  const task = event.data.type === 'load' ? load(event.data.file) : exportMp4();
  task.catch((error: unknown) =>
    scope.postMessage({
      type: 'error',
      message:
        error instanceof Error ? error.message : 'Video processing failed.',
    }),
  );
};
