import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';

async function previewHash(page: import('@playwright/test').Page) {
  return page
    .getByLabel(/preview/i)
    .first()
    .evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const { data } = canvas
        .getContext('2d')!
        .getImageData(0, 0, canvas.width, canvas.height);
      let hash = 0;
      for (let index = 0; index < data.length; index += 97)
        hash = (hash * 31 + data[index]) >>> 0;
      return hash;
    });
}

test('renders and exports a source as square-cell pixels', async ({ page }) => {
  await page.goto('/');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export MP4' })).toBeEnabled();
  const asciiHash = await previewHash(page);

  await page.getByLabel('Render mode').selectOption('Pixelated');
  await expect(page.getByLabel('Pixelated preview')).toBeVisible();
  await expect(page.getByLabel('Grid step')).toHaveValue('8');
  await expect(page.getByLabel('Spacing')).toHaveValue('25');
  await expect(page.getByLabel('Invert brightness mapping')).not.toBeChecked();
  await expect(page.getByLabel('Density')).toHaveCount(0);
  await expect.poll(() => previewHash(page)).not.toBe(asciiHash);
  await expect
    .poll(() =>
      page.getByLabel('Pixelated preview').evaluate((element) => {
        const { data } = (element as HTMLCanvasElement)
          .getContext('2d')!
          .getImageData(0, 0, 320, 180);
        let amber = 0;
        for (let index = 0; index < data.length; index += 4)
          if (
            data[index] > 240 &&
            data[index + 1] > 150 &&
            data[index + 1] < 210
          )
            amber++;
        return amber;
      }),
    )
    .toBeGreaterThan(20);

  await page.getByRole('button', { name: 'Export MP4' }).click();
  const downloadLink = page.getByRole('link', { name: 'Download silent MP4' });
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await downloadLink.click();
  const download = await downloadPromise;
  const output = await download.path();
  expect(output).toBeTruthy();
  const metadata = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,width,height:format=duration',
        '-of',
        'json',
        output!,
      ],
      { encoding: 'utf8' },
    ),
  ) as {
    streams: Array<{ codec_type: string; width?: number; height?: number }>;
    format: { duration: string };
  };
  expect(
    metadata.streams.find((stream) => stream.codec_type === 'video'),
  ).toMatchObject({ width: 320, height: 180 });
  expect(Number(metadata.format.duration)).toBeCloseTo(2, 0);
  const frame = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    output!,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ]);
  let amberPixels = 0;
  for (let index = 0; index < frame.length; index += 3) {
    if (
      frame[index] > 190 &&
      frame[index + 1] > 115 &&
      frame[index + 1] < 220 &&
      frame[index + 2] < 125
    )
      amberPixels++;
  }
  expect(amberPixels).toBeGreaterThan(20);
});
