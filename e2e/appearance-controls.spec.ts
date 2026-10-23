import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

async function canvasPixels(page: Page) {
  return page.getByLabel('ASCII preview').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const rgba = canvas
      .getContext('2d')!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    const rgb: number[] = [];
    for (let index = 0; index < rgba.length; index += 4)
      rgb.push(rgba[index], rgba[index + 1], rgba[index + 2]);
    return rgb;
  });
}

async function setRange(page: Page, label: string, value: number) {
  const slider = page.getByRole('slider', { name: label });
  const box = await slider.boundingBox();
  if (!box) throw new Error(`${label} slider is not visible`);
  const min = Number(await slider.getAttribute('min'));
  const max = Number(await slider.getAttribute('max'));
  const ratio = (value - min) / (max - min);
  await slider.click({
    position: {
      x: Math.max(1, Math.min(box.width - 1, ratio * box.width)),
      y: box.height / 2,
    },
  });
}

function framePixels(path: string) {
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

function meanDifference(left: number[], right: number[]) {
  expect(right).toHaveLength(left.length);
  let total = 0;
  for (let index = 0; index < left.length; index++)
    total += Math.abs(left[index] - right[index]);
  return total / left.length;
}

async function exportFirstFrame(page: Page, outputPath: string) {
  await page.getByRole('button', { name: 'Export MP4' }).click();
  await expect(
    page.getByRole('link', { name: 'Download silent MP4' }),
  ).toBeVisible({ timeout: 60_000 });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download silent MP4' }).click();
  const download = await downloadPromise;
  await download.saveAs(outputPath);
  return framePixels(outputPath);
}

async function loadEditor(page: Page) {
  await page.goto('/');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  await expect(
    page.getByRole('heading', { name: 'landscape.mp4' }),
  ).toBeVisible();
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export MP4' })).toBeEnabled({
    timeout: 60_000,
  });
  await expect
    .poll(() =>
      page.getByLabel('ASCII preview').evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        return [canvas.width, canvas.height];
      }),
    )
    .toEqual([320, 180]);
}

test('density updates the paused preview immediately', async ({ page }) => {
  await loadEditor(page);
  const initial = await canvasPixels(page);
  await setRange(page, 'Density', 24);
  await expect(page.getByRole('slider', { name: 'Density' })).toHaveValue('24');
  await expect
    .poll(async () => meanDifference(initial, await canvasPixels(page)))
    .toBeGreaterThan(1);
});

test('appearance controls update the paused preview and downloaded frames', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await loadEditor(page);
  await expect(page.getByLabel('Density')).toHaveValue('88');
  await expect(page.getByRole('slider', { name: 'Brightness' })).toHaveValue(
    '0',
  );
  await expect(page.getByRole('slider', { name: 'Contrast' })).toHaveValue(
    '100',
  );

  const outputDir = test.info().outputDir;
  const baselinePreview = await canvasPixels(page);
  const baselineExport = await exportFirstFrame(
    page,
    join(outputDir, 'classic-default.mp4'),
  );
  expect(meanDifference(baselinePreview, baselineExport)).toBeLessThan(32);

  const treatments = [
    {
      name: 'density',
      apply: (targetPage: Page) => setRange(targetPage, 'Density', 24),
      expected: '24',
    },
    {
      name: 'brightness',
      apply: (targetPage: Page) => setRange(targetPage, 'Brightness', 100),
      expected: '100',
    },
    {
      name: 'contrast',
      apply: (targetPage: Page) => setRange(targetPage, 'Contrast', 0),
      expected: '0',
    },
    {
      name: 'inversion',
      apply: (targetPage: Page) =>
        targetPage.getByLabel('Invert brightness mapping').check(),
      expected: 'true',
    },
    {
      name: 'minimal',
      apply: (targetPage: Page) =>
        targetPage.getByLabel('Character preset').selectOption('Minimal'),
      expected: 'Minimal',
    },
    {
      name: 'binary',
      apply: (targetPage: Page) =>
        targetPage.getByLabel('Character preset').selectOption('Binary'),
      expected: 'Binary',
    },
  ];

  for (const treatment of treatments) {
    const treatmentPage = await page.context().newPage();
    await loadEditor(treatmentPage);
    await treatment.apply(treatmentPage);
    if (treatment.name === 'inversion') {
      await expect(
        treatmentPage.getByLabel('Invert brightness mapping'),
      ).toBeChecked();
    } else if (treatment.name === 'minimal' || treatment.name === 'binary') {
      await expect(treatmentPage.getByLabel('Character preset')).toHaveValue(
        treatment.expected,
      );
    } else {
      const sliderName =
        treatment.name[0].toUpperCase() + treatment.name.slice(1);
      await expect(
        treatmentPage.getByRole('slider', { name: sliderName }),
      ).toHaveValue(treatment.expected);
    }
    await expect
      .poll(async () =>
        meanDifference(baselinePreview, await canvasPixels(treatmentPage)),
      )
      .toBeGreaterThan(1);
    const visiblePreview = await canvasPixels(treatmentPage);
    const downloadedFrame = await exportFirstFrame(
      treatmentPage,
      join(outputDir, `${treatment.name}.mp4`),
    );
    expect(meanDifference(baselineExport, downloadedFrame)).toBeGreaterThan(1);
    // H.264 introduces small color shifts, so compare with a mean-error tolerance.
    expect(meanDifference(visiblePreview, downloadedFrame)).toBeLessThan(32);
    await treatmentPage.close();
  }
});
