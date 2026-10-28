import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function setDensity(
  page: import('@playwright/test').Page,
  value: number,
) {
  const slider = page.getByLabel('Density');
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

test('cancels generation without downloading, then requests one download and supports save again', async ({
  page,
}) => {
  await page.goto('/?testCodeBundleDelay=15');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  const generate = page.getByRole('button', {
    name: 'Generate ASCII code bundle',
  });
  await expect(generate).toBeEnabled({ timeout: 60_000 });

  let downloadCount = 0;
  page.on('download', () => downloadCount++);
  await generate.click();
  await expect(
    page.getByRole('progressbar', { name: 'Generation progress' }),
  ).toBeVisible();
  await expect(page.getByLabel('Choose source video')).toBeDisabled();
  await expect(page.getByLabel('Density')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Cancel generation' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel generation' }).click();
  await expect(page.getByRole('status')).toContainText('Generation canceled');
  await expect(generate).toBeEnabled();
  await expect(page.getByLabel('Density')).toBeEnabled();
  expect(downloadCount).toBe(0);

  const requestedDownload = page.waitForEvent('download');
  await generate.click();
  await expect(page.getByRole('status')).toContainText('Download requested');
  expect((await requestedDownload).suggestedFilename()).toBe(
    'ascii-code-bundle.zip',
  );
  expect(downloadCount).toBe(1);

  const savedAgain = page.waitForEvent('download');
  await page
    .getByRole('link', { name: 'Save ASCII code bundle again' })
    .click();
  expect((await savedAgain).suggestedFilename()).toBe('ascii-code-bundle.zip');
  expect(downloadCount).toBe(2);
});

test('recovers from a controlled generation failure with source and treatment intact', async ({
  page,
}) => {
  await page.goto('/?testCodeBundleFailure=1');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  const generate = page.getByRole('button', {
    name: 'Generate ASCII code bundle',
  });
  await expect(generate).toBeEnabled({ timeout: 60_000 });
  const density = page.getByLabel('Density');
  await setDensity(page, 104);

  let downloads = 0;
  page.on('download', () => downloads++);
  await generate.click();
  await expect(page.getByRole('status')).toContainText(
    'Code generation failed',
  );
  await expect(
    page.getByRole('heading', { name: 'landscape.mp4' }),
  ).toBeVisible();
  await expect(density).toHaveValue('104');
  expect(downloads).toBe(0);

  const requestedDownload = page.waitForEvent('download');
  await generate.click();
  await expect(page.getByRole('status')).toContainText('Download requested');
  expect((await requestedDownload).suggestedFilename()).toBe(
    'ascii-code-bundle.zip',
  );
});

test('recovers from an in-generation data limit with source and treatment intact', async ({
  page,
}) => {
  await page.goto('/?testCodeBundleLimitAfterFrames=2');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  const generate = page.getByRole('button', {
    name: 'Generate ASCII code bundle',
  });
  await expect(generate).toBeEnabled({ timeout: 60_000 });
  const density = page.getByLabel('Density');
  await setDensity(page, 104);

  let downloads = 0;
  page.on('download', () => downloads++);
  await generate.click();
  await expect(page.getByRole('status')).toContainText(
    'Lower Density in the editor',
  );
  await expect(page.getByRole('status')).toContainText('You can try again.');
  await expect(
    page.getByRole('heading', { name: 'landscape.mp4' }),
  ).toBeVisible();
  await expect(density).toHaveValue('104');
  expect(downloads).toBe(0);

  const requestedDownload = page.waitForEvent('download');
  await generate.click();
  expect((await requestedDownload).suggestedFilename()).toBe(
    'ascii-code-bundle.zip',
  );
});

test('rejects an oversized admitted portrait before generation with Density guidance', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const directory = mkdtempSync(join(tmpdir(), 'ascii-limit-'));
  const fixture = join(directory, 'portrait-near-limit.mp4');
  try {
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=360x640:r=30:d=14.9',
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      fixture,
    ]);
    await page.goto('/');
    await page.getByLabel('Choose source video').setInputFiles(fixture);
    const generate = page.getByRole('button', {
      name: 'Generate ASCII code bundle',
    });
    await expect(generate).toBeEnabled({ timeout: 60_000 });
    const density = page.getByLabel('Density');
    await density.focus();
    await density.press('End');
    await expect(density).toHaveValue('160');
    let downloads = 0;
    page.on('download', () => downloads++);
    await generate.click();
    await expect(page.getByRole('status')).toContainText(
      'Lower Density in the editor',
    );
    await expect(density).toHaveValue('160');
    await expect(generate).toBeEnabled();
    expect(downloads).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('code generation remains available when MP4 encoding is unavailable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'VideoEncoder', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  const generate = page.getByRole('button', {
    name: 'Generate ASCII code bundle',
  });
  await expect(generate).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Export MP4' })).toBeDisabled();
  const requestedDownload = page.waitForEvent('download');
  await generate.click();
  expect((await requestedDownload).suggestedFilename()).toBe(
    'ascii-code-bundle.zip',
  );
});
