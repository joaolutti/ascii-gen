import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

async function loadSource(page: import('@playwright/test').Page, path: string) {
  await page.getByLabel('Choose source video').setInputFiles(path);
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate & download MP4' })).toBeEnabled({
    timeout: 60_000,
  });
}

async function changeStyle(page: import('@playwright/test').Page) {
  await page.getByLabel('Character preset').selectOption('Binary');
  await setRange(page, 'Density', 120);
  await setRange(page, 'Brightness', 32);
  await setRange(page, 'Contrast', 145);
  await page.getByLabel('Invert brightness mapping').check();
  await page.getByLabel('Foreground color').fill('#00ff00');
  await page.getByLabel('Background color').fill('#202040');
  await page.getByLabel('Source-color mode').check();
}

async function setRange(
  page: import('@playwright/test').Page,
  label: string,
  value: number,
) {
  const slider = page.getByRole('slider', { name: label });
  const box = await slider.boundingBox();
  if (!box) throw new Error(`${label} slider is not visible`);
  const min = Number(await slider.getAttribute('min'));
  const max = Number(await slider.getAttribute('max'));
  await slider.click({
    position: {
      x: ((value - min) / (max - min)) * box.width,
      y: box.height / 2,
    },
  });
  const step = Number((await slider.getAttribute('step')) ?? 1);
  const actual = Number(await slider.inputValue());
  const correction = Math.round((value - actual) / step);
  const key = correction >= 0 ? 'ArrowRight' : 'ArrowLeft';
  for (let index = 0; index < Math.abs(correction); index++)
    await slider.press(key);
}

async function downloadFirstFrame(
  page: import('@playwright/test').Page,
  name: string,
) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Save MP4 again' }).click();
  const download = await downloadPromise;
  const path = join(test.info().outputDir, name);
  await download.saveAs(path);
  return Array.from(
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      path,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ]),
  );
}

async function previewPixels(page: import('@playwright/test').Page) {
  return page.getByLabel('ASCII preview').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const rgba = canvas
      .getContext('2d')!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    const pixels: number[] = [];
    for (let index = 0; index < rgba.length; index += 4)
      pixels.push(rgba[index], rgba[index + 1], rgba[index + 2]);
    return pixels;
  });
}

function meanDifference(left: number[], right: number[]) {
  expect(right).toHaveLength(left.length);
  let total = 0;
  for (let index = 0; index < left.length; index++)
    total += Math.abs(left[index] - right[index]);
  return total / left.length;
}

async function expectStyle(page: import('@playwright/test').Page) {
  await expect(page.getByLabel('Character preset')).toHaveValue('Binary');
  await expect(page.getByLabel('Density')).toHaveValue('120');
  await expect(page.getByRole('slider', { name: 'Brightness' })).toHaveValue(
    '32',
  );
  await expect(page.getByLabel('Contrast')).toHaveValue('145');
  await expect(page.getByLabel('Invert brightness mapping')).toBeChecked();
  await expect(page.getByLabel('Foreground color')).toHaveValue('#00ff00');
  await expect(page.getByLabel('Background color')).toHaveValue('#202040');
  await expect(page.getByLabel('Source-color mode')).toBeChecked();
}

test('replaces source video through admission and keeps the selected treatment', async ({
  page,
}) => {
  await page.goto('/');
  await loadSource(page, 'public/fixtures/landscape.mp4');
  await changeStyle(page);
  const originalPreview = await previewPixels(page);
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/color-regions.mp4');
  await expect(
    page.getByRole('heading', { name: 'color-regions.mp4' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate & download MP4' })).toBeEnabled({
    timeout: 60_000,
  });
  await expectStyle(page);
  const replacementPreview = await previewPixels(page);
  expect(meanDifference(originalPreview, replacementPreview)).toBeGreaterThan(
    1,
  );
  await expect(
    page.getByRole('link', { name: 'Save MP4 again' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Generate & download MP4' }).click();
  await expect(
    page.getByRole('link', { name: 'Save MP4 again' }),
  ).toBeVisible({ timeout: 60_000 });
  const replacementFrame = await downloadFirstFrame(page, 'replacement.mp4');
  expect(meanDifference(replacementPreview, replacementFrame)).toBeLessThan(32);
});

test('recovers from a rejected replacement and can replace it with valid media', async ({
  page,
}) => {
  await page.goto('/');
  await loadSource(page, 'public/fixtures/landscape.mp4');
  await page.getByLabel('Choose source video').setInputFiles({
    name: 'unreadable.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('not a video'),
  });
  await expect(page.getByRole('status')).toContainText('could not be read');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/color-regions.mp4');
  await expect(
    page.getByRole('heading', { name: 'color-regions.mp4' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate & download MP4' })).toBeEnabled({
    timeout: 60_000,
  });
});

test('reset restores every default treatment while retaining the source video', async ({
  page,
}) => {
  await page.goto('/');
  await loadSource(page, 'public/fixtures/landscape.mp4');
  await changeStyle(page);
  await page.getByRole('button', { name: 'Reset controls' }).click();
  await page.screenshot({
    path: join(test.info().outputDir, 'reset-editor.png'),
    fullPage: true,
  });
  await expect(
    page.getByRole('heading', { name: 'landscape.mp4' }),
  ).toBeVisible();
  await expect(page.getByLabel('Character preset')).toHaveValue('Classic');
  await expect(page.getByLabel('Density')).toHaveValue('88');
  await expect(page.getByRole('slider', { name: 'Brightness' })).toHaveValue(
    '0',
  );
  await expect(page.getByLabel('Contrast')).toHaveValue('100');
  await expect(page.getByLabel('Invert brightness mapping')).not.toBeChecked();
  await expect(page.getByLabel('Foreground color')).toHaveValue('#ffffff');
  await expect(page.getByLabel('Background color')).toHaveValue('#111111');
  await expect(page.getByLabel('Source-color mode')).not.toBeChecked();
});

test('a changed treatment invalidates an old download and produces distinct exports', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await loadSource(page, 'public/fixtures/landscape.mp4');
  const exportButton = page.getByRole('button', { name: 'Generate & download MP4' });
  await exportButton.click();
  await expect(
    page.getByRole('link', { name: 'Save MP4 again' }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await page.getByLabel('Character preset').selectOption('Minimal');
  await expect(
    page.getByRole('link', { name: 'Save MP4 again' }),
  ).toHaveCount(0);
  await exportButton.click();
  await expect(
    page.getByRole('link', { name: 'Save MP4 again' }),
  ).toBeVisible({ timeout: 60_000 });
  const minimalFrame = await downloadFirstFrame(page, 'minimal.mp4');
  const secondPage = await page.context().newPage();
  await secondPage.goto('/');
  await loadSource(secondPage, 'public/fixtures/landscape.mp4');
  await secondPage.getByLabel('Character preset').selectOption('Binary');
  await secondPage.getByRole('button', { name: 'Generate & download MP4' }).click();
  await expect(
    secondPage.getByRole('link', { name: 'Save MP4 again' }),
  ).toBeVisible({
    timeout: 60_000,
  });
  const binaryFrame = await downloadFirstFrame(secondPage, 'binary.mp4');
  expect(binaryFrame).not.toEqual(minimalFrame);
});

test('canceling an export preserves the full treatment and source for retry', async ({
  page,
}) => {
  await page.goto('/?testExportDelay=20');
  await loadSource(page, 'public/fixtures/landscape.mp4');
  await changeStyle(page);
  await page.getByRole('button', { name: 'Generate & download MP4' }).click();
  await page.getByRole('button', { name: 'Cancel export' }).click();
  await expect(page.getByRole('status')).toContainText('Export canceled');
  await expectStyle(page);
  await expect(
    page.getByRole('heading', { name: 'landscape.mp4' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Generate & download MP4' }).click();
  await expect(
    page.getByRole('link', { name: 'Save MP4 again' }),
  ).toBeVisible({
    timeout: 60_000,
  });
});

test('a failed export preserves the full treatment and source for retry', async ({
  page,
}) => {
  await page.goto('/?testExportFailure=1');
  await loadSource(page, 'public/fixtures/landscape.mp4');
  await changeStyle(page);
  await page.getByRole('button', { name: 'Generate & download MP4' }).click();
  await expect(page.getByRole('status')).toContainText('Export failed');
  await expectStyle(page);
  await expect(
    page.getByRole('heading', { name: 'landscape.mp4' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Generate & download MP4' }).click();
  await expect(
    page.getByRole('link', { name: 'Save MP4 again' }),
  ).toBeVisible({
    timeout: 60_000,
  });
});

test('keeps source video processing in the browser without sending media requests', async ({
  page,
}) => {
  const mediaRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.method() !== 'HEAD')
      mediaRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.goto('/');
  await loadSource(page, 'public/fixtures/landscape.mp4');
  await page.getByRole('button', { name: 'Generate & download MP4' }).click();
  await expect(
    page.getByRole('link', { name: 'Save MP4 again' }),
  ).toBeVisible({
    timeout: 60_000,
  });
  expect(mediaRequests).toEqual([]);
});

test('refresh starts a fresh session with default treatment and no source video', async ({
  page,
}) => {
  await page.goto('/');
  await loadSource(page, 'public/fixtures/landscape.mp4');
  await changeStyle(page);
  await page.reload();
  await expect(page.getByText('Preview will appear here')).toBeVisible();
  await expect(page.getByText('Choose a video')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate & download MP4' })).toBeDisabled();
  await expect(page.getByLabel('Character preset')).toHaveValue('Classic');
  await expect(page.getByLabel('Density')).toHaveValue('88');
  await expect(page.getByRole('slider', { name: 'Brightness' })).toHaveValue(
    '0',
  );
  await expect(page.getByLabel('Contrast')).toHaveValue('100');
  await expect(page.getByLabel('Foreground color')).toHaveValue('#ffffff');
  await expect(page.getByLabel('Background color')).toHaveValue('#111111');
});
