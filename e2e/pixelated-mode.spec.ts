import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test('previews and exports the Pixelated square-cell treatment', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate & download MP4' })).toBeEnabled({
    timeout: 60_000,
  });

  const ascii = page.getByLabel('ASCII preview');
  const originalHash = await ascii.evaluate((element) => {
    const { data } = (element as HTMLCanvasElement)
      .getContext('2d')!
      .getImageData(0, 0, 320, 180);
    return data.reduce((hash, value, index) => (index % 97 ? hash : (hash * 31 + value) >>> 0), 0);
  });

  await page.getByLabel('Render mode').selectOption('Pixelated');
  await expect(page.getByLabel('Pixelated preview')).toBeVisible();
  await expect(page.getByLabel('Grid step')).toHaveValue('8');
  await expect(page.getByLabel('Cell spacing')).toHaveValue('25');
  await expect(page.getByLabel('Density')).toHaveCount(0);
  await expect
    .poll(() =>
      page.getByLabel('Pixelated preview').evaluate((element) => {
        const { data } = (element as HTMLCanvasElement)
          .getContext('2d')!
          .getImageData(0, 0, 320, 180);
        return data.reduce((hash, value, index) => (index % 97 ? hash : (hash * 31 + value) >>> 0), 0);
      }),
    )
    .not.toBe(originalHash);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Generate & download MP4' }).click();
  const download = await downloadPromise;
  const output = await download.path();
  expect(output).toBeTruthy();
  const metadata = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-show_entries',
        'stream=codec_type,width,height,avg_frame_rate,nb_read_frames:format=duration',
        '-of',
        'json',
        output!,
      ],
      { encoding: 'utf8' },
    ),
  ) as {
    streams: Array<{
      codec_type: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      nb_read_frames?: string;
    }>;
    format: { duration: string };
  };
  const video = metadata.streams.find((stream) => stream.codec_type === 'video');
  expect(metadata.streams.filter((stream) => stream.codec_type === 'audio')).toHaveLength(0);
  expect(video).toMatchObject({
    width: 320,
    height: 180,
    avg_frame_rate: '12/1',
    nb_read_frames: '24',
  });
  expect(Number(metadata.format.duration)).toBeCloseTo(2, 1);

  const frame = execFileSync('ffmpeg', [
    '-v', 'error', '-i', output!, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);
  let amberPixels = 0;
  let paleHighlightPixels = 0;
  for (let index = 0; index < frame.length; index += 3)
    if (frame[index]! > 190 && frame[index + 1]! > 115 && frame[index + 1]! < 220 && frame[index + 2]! < 125)
      amberPixels++;
    else if (
      frame[index]! > 220 &&
      frame[index + 1]! > 185 &&
      frame[index + 2]! > 100
    )
      paleHighlightPixels++;
  expect(amberPixels).toBeGreaterThan(20);
  expect(paleHighlightPixels).toBeGreaterThan(0);
});

test('keeps ASCII and Pixelated settings independent and resets only the active mode', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Choose source video').setInputFiles('public/fixtures/landscape.mp4');
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  const density = page.getByLabel('Density');
  await density.focus();
  await density.press('End');
  await expect(density).toHaveValue('160');

  await page.getByLabel('Render mode').selectOption('Pixelated');
  const gridStep = page.getByLabel('Grid step');
  await expect(gridStep).toHaveAttribute('min', '4');
  await expect(gridStep).toHaveAttribute('max', '40');
  await expect(gridStep).toBeVisible();
  await gridStep.focus();
  await gridStep.press('End');
  await expect(page.getByLabel('Grid step')).toHaveValue('40');
  await page.getByLabel('Foreground color').fill('#00ff00');
  await expect(page.getByLabel('Cell spacing')).toHaveAttribute('max', '80');
  await page.getByLabel('Render mode').selectOption('ASCII');
  await expect(page.getByLabel('Density')).toHaveValue('160');

  await page.getByRole('button', { name: 'Reset controls' }).click();
  await expect(page.getByLabel('Density')).toHaveValue('88');
  await page.getByLabel('Render mode').selectOption('Pixelated');
  await expect(page.getByLabel('Grid step')).toHaveValue('40');
  await expect(page.getByLabel('Foreground color')).toHaveValue('#00ff00');
});
