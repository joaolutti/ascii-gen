import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const fixtures = join(process.cwd(), 'test-results', 'source-admission');

function makeVideo(
  name: string,
  options: { size: string; rate: number; duration: number; codec?: string },
) {
  const path = join(fixtures, name);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${options.size}:rate=${options.rate}:duration=${options.duration}`,
    '-an',
    '-c:v',
    options.codec ?? 'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'ultrafast',
    '-crf',
    '35',
    path,
  ]);
  return path;
}

test.beforeAll(() => {
  mkdirSync(fixtures, { recursive: true });
  makeVideo('under-limit.mp4', { size: '320x180', rate: 12, duration: 14.9 });
  makeVideo('at-duration.mp4', { size: '320x180', rate: 12, duration: 15 });
  makeVideo('over-frame-rate.mp4', { size: '320x180', rate: 61, duration: 1 });
  makeVideo('at-frame-rate.mp4', { size: '320x180', rate: 60, duration: 1 });
  makeVideo('over-landscape.mp4', { size: '1922x1080', rate: 12, duration: 1 });
  makeVideo('over-portrait.mp4', { size: '1082x1920', rate: 12, duration: 1 });
  makeVideo('at-landscape.mp4', { size: '1920x1080', rate: 12, duration: 1 });
  makeVideo('at-portrait.mp4', { size: '1080x1920', rate: 12, duration: 1 });
  makeVideo('unsupported.webm', {
    size: '320x180',
    rate: 12,
    duration: 1,
    codec: 'libvpx-vp9',
  });
  writeFileSync(join(fixtures, 'unreadable.mp4'), 'not a media file');
  // A valid MP4 with trailing padding makes the byte boundary deterministic.
  const small = makeVideo('small.mp4', {
    size: '320x180',
    rate: 12,
    duration: 1,
  });
  const atLimit = join(fixtures, 'at-size-limit.mp4');
  copyFileSync(small, atLimit);
  const fd = openSync(atLimit, 'r+');
  ftruncateSync(fd, 100_000_000);
  closeSync(fd);
  const overLimit = join(fixtures, 'over-size-limit.mp4');
  copyFileSync(atLimit, overLimit);
  const overFd = openSync(overLimit, 'r+');
  ftruncateSync(overFd, 100_000_001);
  closeSync(overFd);
});

test('accepts an under-15-second H.264 MP4 and recovers after a rejected selection', async ({
  page,
}) => {
  await page.goto('/');
  const picker = page.getByLabel('Choose source video');
  await picker.setInputFiles(join(fixtures, 'at-duration.mp4'));
  await expect(page.getByRole('status')).toContainText('15 seconds or longer');
  await expect(page.getByRole('button', { name: 'Export MP4' })).toBeDisabled();
  await picker.setInputFiles(join(fixtures, 'under-limit.mp4'));
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export MP4' })).toBeEnabled();
});

test('rejects metadata beyond each source-video limit', async ({ page }) => {
  await page.goto('/');
  const picker = page.getByLabel('Choose source video');
  for (const [fixture, explanation] of [
    ['over-frame-rate.mp4', '60 fps'],
    ['over-landscape.mp4', '1920 × 1080'],
    ['over-portrait.mp4', '1080 × 1920'],
    ['over-size-limit.mp4', '100 MB'],
  ]) {
    await picker.setInputFiles(join(fixtures, fixture));
    await expect(page.getByRole('status')).toContainText(explanation);
    await expect(
      page.getByRole('button', { name: 'Export MP4' }),
    ).toBeDisabled();
  }
});

test('accepts exactly 100 MB, 60 fps, and the landscape and portrait 1080p bounds', async ({
  page,
}) => {
  await page.goto('/');
  const picker = page.getByLabel('Choose source video');
  for (const fixture of [
    'at-size-limit.mp4',
    'at-frame-rate.mp4',
    'at-landscape.mp4',
    'at-portrait.mp4',
  ]) {
    await picker.setInputFiles(join(fixtures, fixture));
    await expect(page.getByLabel('ASCII preview')).toBeVisible();
    await expect(page.getByRole('status')).not.toContainText(
      /larger than|exceeds|15 seconds or longer/,
    );
  }
});

test('rejects unsupported dropped media', async ({ page }) => {
  await page.goto('/');
  const bytes = readFileSync(join(fixtures, 'unsupported.webm')).toString(
    'base64',
  );
  await page.evaluate((content) => {
    const binary = atob(content);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const file = new File([bytes], 'unsupported.webm', { type: 'video/webm' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    document
      .querySelector('[aria-label="Video converter"]')
      ?.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true }),
      );
  }, bytes);
  await expect(page.getByRole('status')).toContainText('H.264 MP4');
});

test('accepts a dropped H.264 MP4 through the same preview and export path', async ({
  page,
}) => {
  await page.goto('/');
  const bytes = readFileSync(join(fixtures, 'small.mp4')).toString('base64');
  await page.evaluate((content) => {
    const binary = atob(content);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const file = new File([bytes], 'small.mp4', { type: 'video/mp4' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    document
      .querySelector('[aria-label="Video converter"]')
      ?.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true }),
      );
  }, bytes);
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export MP4' })).toBeEnabled();
});

test('explains when a selected file is not readable media', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('Choose source video')
    .setInputFiles(join(fixtures, 'unreadable.mp4'));
  await expect(page.getByRole('status')).toContainText('could not be read');
  await expect(page.getByRole('button', { name: 'Export MP4' })).toBeDisabled();
});

test('keeps export disabled when the device cannot encode H.264 MP4', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const encoder = globalThis.VideoEncoder;
    if (encoder) encoder.isConfigSupported = async () => ({ supported: false });
  });
  await page.goto('/');
  const picker = page.getByLabel('Choose source video');
  await picker.setInputFiles(join(fixtures, 'small.mp4'));
  await expect(page.getByRole('status')).toContainText(
    'cannot encode H.264 MP4',
  );
  await expect(page.getByRole('button', { name: 'Export MP4' })).toBeDisabled();
});
