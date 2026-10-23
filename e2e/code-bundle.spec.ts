import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('downloads an offline runnable ASCII code bundle from the editor', async ({
  page,
  context,
}) => {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1:4173)/, (route) =>
    route.abort(),
  );
  await page.goto('/');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/color-regions.mp4');
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download ASCII code bundle' }),
  ).toBeEnabled({ timeout: 60_000 });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download ASCII code bundle' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('ascii-code-bundle.zip');
  const directory = mkdtempSync(join(tmpdir(), 'ascii-bundle-'));
  try {
    const archive = join(directory, download.suggestedFilename());
    await download.saveAs(archive);
    execFileSync('unzip', ['-q', archive, '-d', directory]);
    const data = JSON.parse(
      readFileSync(join(directory, 'data.json'), 'utf8'),
    ) as {
      version: number;
      width: number;
      height: number;
      columns: number;
      rows: number;
      cellWidth: number;
      cellHeight: number;
      foreground: string;
      background: string;
      duration: number;
      frames: Array<{ timestamp: number; duration: number; rows: string[] }>;
    };
    expect(data.version).toBe(1);
    expect(data).toMatchObject({
      width: 320,
      height: 180,
      columns: 88,
      foreground: '#ffffff',
      background: '#111111',
      duration: 2,
    });
    expect(data.rows).toBeGreaterThan(0);
    expect(data.cellWidth).toBeGreaterThan(0);
    expect(data.cellHeight).toBeGreaterThan(0);
    expect(data.frames.length).toBeGreaterThan(1);
    expect(data.frames[0]?.timestamp).toBe(0);
    expect(data.frames[0]?.duration).toBeCloseTo(1 / 12, 4);
    expect(
      data.frames.at(-1)!.timestamp + data.frames.at(-1)!.duration,
    ).toBeCloseTo(2, 4);
    expect(
      data.frames.every((frame) => frame.rows.length === data.rows),
    ).toBe(true);
    expect(
      data.frames.every((frame) =>
        frame.rows.every((row) => row.length === data.columns),
      ),
    ).toBe(true);
    const middleRow = data.frames[0]!.rows[Math.floor(data.rows / 2)]!;
    expect(middleRow[22]).toBe('+');
    expect(middleRow[66]).toBe('^');
    expect(readFileSync(join(directory, 'player.js'), 'utf8')).toContain(
      'requestAnimationFrame',
    );
    expect(readFileSync(join(directory, 'README.txt'), 'utf8')).toContain('offline');

    const example = join(directory, 'index.html');
    const consumer = await context.newPage();
    await consumer.goto(`file://${example}`);
    await expect(consumer.getByRole('button', { name: 'Play' })).toBeVisible();
    await expect(consumer.locator('pre')).toContainText(/[^\s]/);
    expect(
      await consumer
        .locator('pre')
        .evaluate((pre) => getComputedStyle(pre).color),
    ).toBe('rgb(255, 255, 255)');
    await consumer.getByRole('button', { name: 'Play' }).click();
    await expect(consumer.getByRole('button', { name: 'Pause' })).toBeVisible();
    await consumer.close();

    await page.getByLabel('Source-color mode').check();
    await page.getByRole('button', { name: 'Download ASCII code bundle' }).click();
    await expect(page.getByRole('status')).toContainText(
      'currently support fixed colors',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
