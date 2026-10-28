import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';

async function frameHash(page: import('@playwright/test').Page) {
  return page.getByLabel('ASCII preview').evaluate((element) => {
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

async function seekTo(page: import('@playwright/test').Page, seconds: number) {
  await page
    .getByRole('slider', { name: 'Preview position' })
    .evaluate((element, value) => {
      const slider = element as HTMLInputElement;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(slider, String(value));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }, seconds);
}

test('plays, pauses, and seeks the ASCII preview without changing export timing', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  await expect(
    page.getByRole('button', { name: 'Play preview' }),
  ).toBeVisible();
  await expect(
    page.getByRole('slider', { name: 'Preview position' }),
  ).toBeVisible();

  const initial = await frameHash(page);
  await page.getByRole('button', { name: 'Play preview' }).click();
  await expect(
    page.getByRole('button', { name: 'Pause preview' }),
  ).toBeVisible();
  await expect
    .poll(() => frameHash(page), { timeout: 5_000 })
    .not.toBe(initial);

  const position = page.getByRole('slider', { name: 'Preview position' });
  await page.getByRole('button', { name: 'Pause preview' }).click();
  await seekTo(page, 1.9);
  await page.getByRole('button', { name: 'Play preview' }).click();
  await expect
    .poll(
      () =>
        position.evaluate((element) =>
          Number((element as HTMLInputElement).value),
        ),
      {
        timeout: 5_000,
      },
    )
    .toBeLessThan(1);

  await page.getByRole('button', { name: 'Pause preview' }).click();
  const paused = await frameHash(page);
  await page.waitForTimeout(400);
  expect(await frameHash(page)).toBe(paused);

  await seekTo(page, 1.5);
  await expect.poll(() => frameHash(page), { timeout: 5_000 }).not.toBe(paused);

  await expect(page.getByRole('button', { name: 'Generate & download MP4' })).toBeEnabled();
  await page.getByRole('button', { name: 'Generate & download MP4' }).click();
  await expect(
    page.getByRole('link', { name: 'Save MP4 again' }),
  ).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Save MP4 again' }).click();
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
        'stream=codec_type,nb_frames:format=duration',
        '-of',
        'json',
        output!,
      ],
      { encoding: 'utf8' },
    ),
  ) as {
    streams: Array<{ codec_type: string; nb_frames?: string }>;
    format: { duration: string };
  };
  expect(Number(metadata.format.duration)).toBeCloseTo(2, 0);
  expect(
    metadata.streams.filter((stream) => stream.codec_type === 'video')[0]
      .nb_frames,
  ).toBe('24');
});
