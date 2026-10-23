import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const fixtures = join(process.cwd(), 'test-results', 'export-proportions');

function makeVideo(name: string, size: string, rate: number, duration: number) {
  const path = join(fixtures, name);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=${rate}:duration=${duration}`,
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'ultrafast',
    '-crf',
    '30',
    path,
  ]);
  return path;
}

test.beforeAll(() => {
  mkdirSync(fixtures, { recursive: true });
  makeVideo('portrait.mp4', '1080x1920', 12, 1.5);
  makeVideo('landscape.mp4', '1920x1080', 12, 1.5);
  makeVideo('smaller.mp4', '160x90', 12, 1.5);
  makeVideo('high-rate.mp4', '320x180', 48, 1.5);
});

async function exportAndProbe(
  page: import('@playwright/test').Page,
  fixture: string,
) {
  await page.goto('/');
  await page.getByLabel('Choose source video').setInputFiles(fixture);
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export MP4' })).toBeEnabled();
  await page.getByRole('button', { name: 'Export MP4' }).click();
  await expect(
    page.getByRole('link', { name: 'Download silent MP4' }),
  ).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download silent MP4' }).click();
  const download = await downloadPromise;
  const output = join(test.info().outputDir, download.suggestedFilename());
  await download.saveAs(output);
  const metadata = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,width,height,avg_frame_rate,r_frame_rate,nb_frames:format=duration:frame=media_type,best_effort_timestamp_time',
        '-show_frames',
        '-of',
        'json',
        output,
      ],
      { encoding: 'utf8' },
    ),
  ) as {
    streams: Array<{
      codec_type: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      nb_frames?: string;
    }>;
    format: { duration: string };
    frames: Array<{
      media_type: string;
      best_effort_timestamp_time: string;
    }>;
  };
  return { metadata, output };
}

function videoStream(metadata: Awaited<ReturnType<typeof exportAndProbe>>) {
  return metadata.streams.find((stream) => stream.codec_type === 'video')!;
}

test('preserves portrait display orientation, proportions, duration, and silent output', async ({
  page,
}) => {
  const { metadata } = await exportAndProbe(
    page,
    join(fixtures, 'portrait.mp4'),
  );
  const video = videoStream(metadata);
  expect(video.height).toBeGreaterThan(video.width!);
  expect(video).toMatchObject({ width: 720, height: 1280 });
  const [rateNumerator, rateDenominator] = video
    .avg_frame_rate!.split('/')
    .map(Number);
  expect(rateNumerator / rateDenominator).toBe(12);
  const frameTimestamps = metadata.frames
    .filter((frame) => frame.media_type === 'video')
    .map((frame) => Number(frame.best_effort_timestamp_time));
  expect(frameTimestamps).toHaveLength(18);
  frameTimestamps.slice(1).forEach((timestamp, index) => {
    // MP4 timestamp quantization may shift individual frame spacing by up to 2 ms.
    expect(
      Math.abs(timestamp - frameTimestamps[index] - 1 / 12),
    ).toBeLessThanOrEqual(0.002);
  });
  // Allow one source-frame interval of duration drift from container timing.
  expect(Number(metadata.format.duration)).toBeGreaterThanOrEqual(1.5 - 1 / 12);
  expect(Number(metadata.format.duration)).toBeLessThanOrEqual(1.5 + 1 / 12);
  expect(
    metadata.streams.filter((stream) => stream.codec_type === 'audio'),
  ).toHaveLength(0);
});

test('fits landscape output within 1280 by 720 without changing its proportions', async ({
  page,
}) => {
  const { metadata, output } = await exportAndProbe(
    page,
    join(fixtures, 'landscape.mp4'),
  );
  const video = videoStream(metadata);
  expect(video).toMatchObject({ width: 1280, height: 720 });
  expect(video.width! / video.height!).toBeCloseTo(1920 / 1080, 2);

  const preview = await page.getByLabel('ASCII preview').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const { data } = canvas
      .getContext('2d')!
      .getImageData(0, 0, canvas.width, canvas.height);
    const values: number[] = [];
    for (let pixel = 0; pixel < canvas.width * canvas.height; pixel += 4093) {
      values.push(data[pixel * 4], data[pixel * 4 + 1], data[pixel * 4 + 2]);
    }
    return values;
  });
  const decoded = execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      output,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const differences = preview.map((value, index) =>
    Math.abs(value - decoded[Math.floor(index / 3) * 4093 * 3 + (index % 3)]),
  );
  expect(
    differences.reduce((total, difference) => total + difference, 0) /
      differences.length,
  ).toBeLessThan(20);
});

test('keeps smaller source dimensions without upscaling', async ({ page }) => {
  const { metadata } = await exportAndProbe(
    page,
    join(fixtures, 'smaller.mp4'),
  );
  expect(videoStream(metadata)).toMatchObject({ width: 160, height: 90 });
});

test('caps export at 30 fps and preserves duration for higher-rate input', async ({
  page,
}) => {
  const { metadata } = await exportAndProbe(
    page,
    join(fixtures, 'high-rate.mp4'),
  );
  const video = videoStream(metadata);
  const [numerator, denominator] = video.avg_frame_rate!.split('/').map(Number);
  expect(numerator / denominator).toBeLessThanOrEqual(30);
  expect(Number(video.nb_frames)).toBeCloseTo(45, 0);
  const timestamps = metadata.frames
    .filter((frame) => frame.media_type === 'video')
    .map((frame) => Number(frame.best_effort_timestamp_time));
  expect(timestamps).toHaveLength(45);
  timestamps.slice(1).forEach((timestamp, index) => {
    expect(
      Math.abs(timestamp - timestamps[index] - 1 / 30),
    ).toBeLessThanOrEqual(0.002);
  });
  expect(Number(metadata.format.duration)).toBeGreaterThanOrEqual(1.5 - 1 / 30);
  expect(Number(metadata.format.duration)).toBeLessThanOrEqual(1.5 + 1 / 30);
  expect(
    metadata.streams.filter((stream) => stream.codec_type === 'audio'),
  ).toHaveLength(0);
});
