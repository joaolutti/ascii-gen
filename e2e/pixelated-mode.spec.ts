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
      x: Math.max(
        1,
        Math.min(box.width - 1, ((value - min) / (max - min)) * box.width),
      ),
      y: box.height / 2,
    },
  });
  const step = Number((await slider.getAttribute('step')) ?? 1);
  const actual = Number(await slider.inputValue());
  const correction = Math.round((value - actual) / step);
  for (let index = 0; index < Math.abs(correction); index++)
    await slider.press(correction > 0 ? 'ArrowRight' : 'ArrowLeft');
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
  await expect(page.getByLabel('Cell spacing')).toHaveValue('25');
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

test('keeps mode settings independent and resets only the active mode', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  await expect
    .poll(() =>
      page.getByLabel('ASCII preview').evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        return [canvas.width, canvas.height];
      }),
    )
    .toEqual([320, 180]);
  await expect.poll(() => previewHash(page)).not.toBe(0);
  const asciiHash = await previewHash(page);
  await page.getByLabel('Density').focus();
  await page.getByLabel('Density').press('End');
  await expect(page.getByLabel('Density')).toHaveValue('160');

  await page.getByLabel('Render mode').selectOption('Pixelated');
  await expect.poll(() => previewHash(page)).not.toBe(asciiHash);
  const defaultPixelatedHash = await previewHash(page);
  const gridStep = page.getByRole('slider', { name: 'Grid step' });
  await expect(gridStep).toHaveAttribute('min', '4');
  await expect(gridStep).toHaveAttribute('max', '40');
  const spacing = page.getByRole('slider', { name: 'Cell spacing' });
  await expect(spacing).toHaveAttribute('min', '0');
  await expect(spacing).toHaveAttribute('max', '80');
  await expect(gridStep).toHaveValue('8');
  await expect(spacing).toHaveValue('25');
  await expect(
    page.getByRole('slider', { name: 'Brightness' }),
  ).toHaveAttribute('min', '-100');
  await expect(
    page.getByRole('slider', { name: 'Brightness' }),
  ).toHaveAttribute('max', '100');
  await expect(page.getByRole('slider', { name: 'Contrast' })).toHaveAttribute(
    'max',
    '200',
  );
  await expect(page.getByLabel('Invert brightness mapping')).not.toBeChecked();
  await setRange(page, 'Grid step', 40);
  await setRange(page, 'Cell spacing', 80);
  await setRange(page, 'Brightness', 55);
  await setRange(page, 'Contrast', 200);
  await page.getByLabel('Foreground color').fill('#00ff00');
  await page.getByLabel('Background color').fill('#101020');
  await expect.poll(() => previewHash(page)).not.toBe(defaultPixelatedHash);
  const uninvertedHash = await previewHash(page);
  await page.getByLabel('Invert brightness mapping').check();
  await expect.poll(() => previewHash(page)).not.toBe(uninvertedHash);
  const pixelatedBeforeReset = await previewHash(page);
  await page.getByRole('button', { name: 'Export MP4' }).click();
  const downloadLink = page.getByRole('link', { name: 'Download silent MP4' });
  await expect(downloadLink).toBeVisible({ timeout: 60_000 });
  const downloadPromise = page.waitForEvent('download');
  await downloadLink.click();
  const output = await (await downloadPromise).path();
  expect(output).toBeTruthy();
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
  let greenPixels = 0;
  for (let index = 0; index < frame.length; index += 3)
    if (frame[index] < 70 && frame[index + 1] > 150 && frame[index + 2] < 90)
      greenPixels++;
  expect(greenPixels).toBeGreaterThan(100);
  expect(greenPixels).toBeLessThan((frame.length / 3) * 0.1);

  const position = page.getByRole('slider', { name: 'Preview position' });
  await page.getByRole('button', { name: 'Play preview' }).click();
  await expect
    .poll(() =>
      position.evaluate((element) =>
        Number((element as HTMLInputElement).value),
      ),
    )
    .toBeGreaterThan(0.2);
  const timeBeforeReset = Number(await position.inputValue());
  await page.getByLabel('Render mode').selectOption('ASCII');
  await expect(page.getByLabel('Density')).toHaveValue('160');
  await page.getByRole('button', { name: 'Reset controls' }).click();
  await expect(page.getByLabel('Density')).toHaveValue('88');
  await expect(
    page.getByRole('button', { name: 'Pause preview' }),
  ).toBeVisible();
  await expect
    .poll(() =>
      position.evaluate((element) =>
        Number((element as HTMLInputElement).value),
      ),
    )
    .toBeGreaterThan(timeBeforeReset);
  await page.getByLabel('Render mode').selectOption('Pixelated');
  await expect(gridStep).toHaveValue('40');
  await expect(spacing).toHaveValue('80');
  await expect(page.getByRole('slider', { name: 'Brightness' })).toHaveValue(
    '55',
  );
  await expect(page.getByRole('slider', { name: 'Contrast' })).toHaveValue(
    '200',
  );
  await expect(page.getByLabel('Invert brightness mapping')).toBeChecked();
  await expect(page.getByLabel('Foreground color')).toHaveValue('#00ff00');
  await expect(page.getByLabel('Background color')).toHaveValue('#101020');
  await page.getByRole('button', { name: 'Reset controls' }).click();
  await expect(gridStep).toHaveValue('8');
  await expect(spacing).toHaveValue('25');
  await expect(page.getByRole('slider', { name: 'Brightness' })).toHaveValue(
    '0',
  );
  await expect(page.getByLabel('Foreground color')).toHaveValue('#ffb547');
  await expect(page.getByLabel('Background color')).toHaveValue('#000000');
  await expect.poll(() => previewHash(page)).not.toBe(pixelatedBeforeReset);
});
