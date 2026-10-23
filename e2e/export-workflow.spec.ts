import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

async function setDensity(page: Page, value: number) {
  const slider = page.getByRole('slider', { name: 'Density' });
  const box = await slider.boundingBox();
  if (!box) throw new Error('Density slider is not visible');
  const min = Number(await slider.getAttribute('min'));
  const max = Number(await slider.getAttribute('max'));
  await slider.click({
    position: {
      x: ((value - min) / (max - min)) * box.width,
      y: box.height / 2,
    },
  });
}

test('shows progress, locks editing, cancels cleanly, and can export again', async ({
  page,
}) => {
  await page.goto('/?testExportDelay=20');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export MP4' })).toBeEnabled({
    timeout: 60_000,
  });
  const exportButton = page.getByRole('button', { name: 'Export MP4' });
  await exportButton.click();
  await expect(
    page.getByRole('progressbar', { name: 'Export progress' }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole('progressbar', { name: 'Export progress' })
        .evaluate((element) => (element as HTMLProgressElement).value),
    )
    .toBeGreaterThan(0);
  await expect(page.getByLabel('Choose source video')).toBeDisabled();
  await expect(page.getByLabel('Density')).toBeDisabled();
  await expect(page.getByLabel('Play preview')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Cancel export' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel export' }).click();
  await expect(page.getByRole('status')).toContainText('Export canceled');
  await expect(
    page.getByRole('progressbar', { name: 'Export progress' }),
  ).toHaveCount(0);
  await expect(exportButton).toBeEnabled();
  await expect(page.getByLabel('Density')).toBeEnabled();
  await expect(
    page.getByRole('link', { name: 'Download silent MP4' }),
  ).toHaveCount(0);

  await exportButton.click();
  await expect(
    page.getByRole('link', { name: 'Download silent MP4' }),
  ).toBeVisible();
  await setDensity(page, 104);
  await exportButton.click();
  await expect(
    page.getByRole('link', { name: 'Download silent MP4' }),
  ).toBeVisible();
});

test('recovers from a controlled export failure with the source and treatment intact', async ({
  page,
}) => {
  await page.goto('/?testExportFailure=1');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  const density = page.getByLabel('Density');
  await setDensity(page, 104);
  await page.getByRole('button', { name: 'Export MP4' }).click();
  await expect(page.getByRole('status')).toContainText('Export failed');
  await expect(page.getByRole('status')).toContainText('try again');
  await expect(
    page.getByRole('heading', { name: 'landscape.mp4' }),
  ).toBeVisible();
  await expect(density).toHaveValue('104');
  await expect(
    page.getByRole('link', { name: 'Download silent MP4' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Export MP4' }).click();
  await expect(
    page.getByRole('link', { name: 'Download silent MP4' }),
  ).toBeVisible();
});

test('exports a playable silent MP4 repeatedly after cancellation', async ({
  page,
}) => {
  await page.goto('/?testExportDelay=25');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  await expect(page.getByRole('button', { name: 'Export MP4' })).toBeEnabled({
    timeout: 60_000,
  });
  const exportButton = page.getByRole('button', { name: 'Export MP4' });
  await exportButton.click();
  await page.getByRole('button', { name: 'Cancel export' }).click();
  await expect(page.getByRole('button', { name: 'Export MP4' })).toBeEnabled();
  await exportButton.click();
  await expect(
    page.getByRole('link', { name: 'Download silent MP4' }),
  ).toBeVisible();

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
  ).toMatchObject({
    width: 320,
    height: 180,
  });
  expect(Number(metadata.format.duration)).toBeCloseTo(2, 0);
});
