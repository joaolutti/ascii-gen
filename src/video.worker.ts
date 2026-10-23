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
  file = sourceFile;
  input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(sourceFile),
  });
  const mime = await input.getMimeType();
  if (!mime.startsWith('video/mp4') || !/avc1/i.test(mime))
    throw new Error('Choose an H.264 MP4 source video.');
  track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('This MP4 has no video track.');
  width = track.displayWidth;
  height = track.displayHeight;
  duration = await input.computeDuration();
  sourceFrameRate =
    (await track.computeFrameRateMetrics()).bestGuessFrameRate || 30;
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
  const supported =
    typeof VideoEncoder !== 'undefined' &&
    (
      await VideoEncoder.isConfigSupported({
        codec: 'avc1.42001f',
        width: canvas.width,
        height: canvas.height,
        bitrate: 1_500_000,
        framerate: 30,
      })
    ).supported === true;
  scope.postMessage({
    type: 'ready',
    supported,
    message: supported
      ? 'Classic characters · white on near-black'
      : 'This browser cannot encode H.264 MP4 on this device.',
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
