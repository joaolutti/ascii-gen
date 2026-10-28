import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

test('selects a local clip, previews ASCII, and exports a silent MP4', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  await expect(
    page.getByRole('heading', { name: 'landscape.mp4' }),
  ).toBeVisible();
  await expect(page.getByRole('status')).not.toContainText(
    'Reading source video locally…',
  );
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  await expect
    .poll(() =>
      page.getByLabel('ASCII preview').evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const pixels = canvas
          .getContext('2d')
          ?.getImageData(0, 0, canvas.width, canvas.height).data;
        return pixels
          ? new Set(Array.from(pixels).filter((_, index) => index % 4 !== 3))
              .size
          : 0;
      }),
    )
    .toBeGreaterThan(2);

  const exportButton = page.getByRole('button', { name: 'Generate & download MP4' });
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  await expect(
    page.getByRole('link', { name: 'Save MP4 again' }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Save MP4 again' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.mp4$/);
  const output = join(test.info().outputDir, download.suggestedFilename());
  await download.saveAs(output);
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
        output,
      ],
      { encoding: 'utf8' },
    ),
  ) as {
    streams: Array<{ codec_type: string; width?: number; height?: number }>;
    format: { duration: string };
  };
  expect(
    metadata.streams.filter((stream) => stream.codec_type === 'audio'),
  ).toHaveLength(0);
  expect(
    metadata.streams.find((stream) => stream.codec_type === 'video'),
  ).toMatchObject({ width: 320, height: 180 });
  expect(Number(metadata.format.duration)).toBeCloseTo(2, 0);
});
