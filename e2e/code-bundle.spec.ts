import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type BrowserPlayer = {
  play(): void;
  pause(): void;
  seek(time: number): void;
  setLoop(enabled: boolean): void;
  getCurrentTime(): number;
  dispose(): void;
};

declare global {
  interface Window {
    AsciiVideoPlayer: {
      mount(options: {
        container: HTMLElement;
        data: unknown;
        autoplay?: boolean;
      }): BrowserPlayer;
    };
    testPlayer: BrowserPlayer;
    testColorPlayer: BrowserPlayer;
  }
}

test('downloads an offline runnable ASCII code bundle from the editor', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await context.route(/^https?:\/\/(?!127\.0\.0\.1:4173)/, (route) =>
    route.abort(),
  );
  await page.goto('/');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/color-regions.mp4');
  await expect(page.getByLabel('ASCII preview')).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByRole('button', { name: 'Generate ASCII code bundle' }),
  ).toBeEnabled({ timeout: 60_000 });

  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Generate ASCII code bundle' })
    .click();
  await expect(page.getByRole('status')).toContainText('Download requested');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('ascii-code-bundle.zip');
  const directory = mkdtempSync(join(tmpdir(), 'ascii-bundle-'));
  try {
    const archive = join(directory, download.suggestedFilename());
    await download.saveAs(archive);
    execFileSync('unzip', ['-o', '-q', archive, '-d', directory]);
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
      frames: Array<{
        timestamp: number;
        duration: number;
        rows: string[];
        colors?: string[];
      }>;
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
    expect(data.frames.every((frame) => frame.rows.length === data.rows)).toBe(
      true,
    );
    expect(
      data.frames.every((frame) =>
        frame.rows.every((row) => row.length === data.columns),
      ),
    ).toBe(true);
    const middleRow = data.frames[0]!.rows[Math.floor(data.rows / 2)]!;
    expect(middleRow[22]).toBe('[');
    expect(readFileSync(join(directory, 'player.js'), 'utf8')).toContain(
      'requestAnimationFrame',
    );
    expect(readFileSync(join(directory, 'README.txt'), 'utf8')).toContain(
      'offline',
    );

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

    const saveAgainPromise = page.waitForEvent('download');
    await page
      .getByRole('link', { name: 'Save ASCII code bundle again' })
      .click();
    expect((await saveAgainPromise).suggestedFilename()).toBe(
      'ascii-code-bundle.zip',
    );

    await page.getByLabel('Source-color mode').check();
    const sourceColorDownloadPromise = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Generate ASCII code bundle' })
      .click();
    await expect(page.getByRole('status')).toContainText('Download requested');
    const sourceColorDownload = await sourceColorDownloadPromise;
    const sourceColorArchive = join(directory, 'source-colors.zip');
    await sourceColorDownload.saveAs(sourceColorArchive);
    const sourceColorDirectory = join(directory, 'source-color');
    mkdirSync(sourceColorDirectory);
    execFileSync('unzip', [
      '-q',
      sourceColorArchive,
      '-d',
      sourceColorDirectory,
    ]);
    const sourceColorData = JSON.parse(
      readFileSync(join(sourceColorDirectory, 'data.json'), 'utf8'),
    ) as {
      frames: Array<{ rows: string[]; colors?: string[] }>;
      rows: number;
      columns: number;
      background: string;
    };
    expect(sourceColorData.frames.every((frame) => frame.colors)).toBe(true);
    const middle = Math.floor(sourceColorData.rows / 2);
    const sampledColors = sourceColorData.frames[0]!.colors![middle]!;
    const leftColor = Number.parseInt(
      sampledColors.slice(22 * 6, 22 * 6 + 6),
      16,
    );
    const rightColor = Number.parseInt(
      sampledColors.slice(66 * 6, 66 * 6 + 6),
      16,
    );
    expect(leftColor >> 16).toBeGreaterThan(200);
    expect((leftColor >> 8) & 255).toBeLessThan(40);
    expect(leftColor & 255).toBeLessThan(40);
    expect(rightColor >> 16).toBeLessThan(40);
    expect((rightColor >> 8) & 255).toBeLessThan(40);
    expect(rightColor & 255).toBeGreaterThan(200);

    const sourceColorExample = await context.newPage();
    await sourceColorExample.goto(
      `file://${join(sourceColorDirectory, 'index.html')}`,
    );
    await expect(sourceColorExample.locator('pre span').first()).toHaveCSS(
      'color',
      /rgb\((2\d\d|255), \d+, 0\)/,
    );
    await expect(sourceColorExample.locator('body')).toHaveCSS(
      'background-color',
      'rgb(17, 17, 17)',
    );
    await sourceColorExample.close();

    const separateConsumer = await context.newPage();
    await separateConsumer.emulateMedia({ reducedMotion: 'reduce' });
    await separateConsumer.setContent(
      '<main id="host" style="width:160px"></main>',
    );
    await separateConsumer.addScriptTag({ path: join(directory, 'player.js') });
    await separateConsumer.evaluate(() => {
      const data = {
        version: 1,
        width: 320,
        height: 180,
        columns: 24,
        rows: 2,
        cellWidth: 320 / 24,
        cellHeight: 90,
        fontSize: 90,
        foreground: '#22cc44',
        background: '#112233',
        duration: 0.2,
        frames: [
          {
            timestamp: 0,
            duration: 0.1,
            rows: ['A'.repeat(24), 'A'.repeat(24)],
          },
          {
            timestamp: 0.1999995,
            duration: 0.0000005,
            rows: ['B'.repeat(24), 'B'.repeat(24)],
          },
        ],
      };
      const player = window.AsciiVideoPlayer.mount({
        container: document.querySelector('#host'),
        data,
        autoplay: true,
      });
      window.testPlayer = player;

      const colorData = {
        ...data,
        frames: data.frames.map((frame) => ({
          ...frame,
          colors: Array.from({ length: data.rows }, () =>
            'ff0000'.repeat(data.columns),
          ),
        })),
      };
      const colorHost = document.createElement('main');
      colorHost.id = 'source-color-host';
      colorHost.style.width = '160px';
      document.body.append(colorHost);
      window.testColorPlayer = window.AsciiVideoPlayer.mount({
        container: colorHost,
        data: colorData,
      });
    });
    const hostedPre = separateConsumer.locator('#host pre');
    await expect(hostedPre).toContainText(/^A/);
    await expect(hostedPre).toHaveCSS('color', 'rgb(34, 204, 68)');
    await expect(hostedPre).toHaveCSS('background-color', 'rgb(17, 34, 51)');
    await expect(
      separateConsumer.locator('#source-color-host pre span').first(),
    ).toHaveCSS('color', 'rgb(255, 0, 0)');
    await expect(separateConsumer.locator('#source-color-host pre')).toHaveCSS(
      'background-color',
      'rgb(17, 34, 51)',
    );
    await expect(
      separateConsumer.locator('#host').getByRole('button', { name: 'Play' }),
    ).toBeVisible();
    expect(
      await hostedPre.evaluate((pre) => pre.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(160);
    await separateConsumer.evaluate(() => window.testPlayer.seek(0.1999995));
    await expect(hostedPre).toContainText(/^B/);
    await separateConsumer.evaluate(() => window.testPlayer.seek(0.2));
    await expect(hostedPre).toContainText(/^B/);
    await separateConsumer.evaluate(() => {
      window.testPlayer.setLoop(false);
      window.testPlayer.seek(0);
    });
    await expect(hostedPre).toContainText(/^A/);
    await separateConsumer.evaluate(() => {
      window.testPlayer.play();
    });
    await expect(
      separateConsumer.locator('#host').getByRole('button', { name: 'Play' }),
    ).toBeVisible({ timeout: 1000 });
    await expect(hostedPre).toContainText(/^B/);
    expect(
      await separateConsumer.evaluate(() => window.testPlayer.getCurrentTime()),
    ).toBeCloseTo(0.2, 2);
    await separateConsumer.evaluate(() => {
      window.testPlayer.seek(0);
      window.testPlayer.setLoop(true);
      window.testPlayer.play();
    });
    await separateConsumer.waitForTimeout(350);
    expect(
      await separateConsumer.evaluate(() => window.testPlayer.getCurrentTime()),
    ).toBeLessThan(0.2);
    await separateConsumer.evaluate(() => window.testPlayer.dispose());
    await expect(separateConsumer.locator('#host').locator('> *')).toHaveCount(
      0,
    );
    await separateConsumer.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
