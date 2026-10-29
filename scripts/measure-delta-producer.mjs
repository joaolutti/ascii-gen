/* global CanvasRenderingContext2D, document, window */
import { chromium } from '@playwright/test';
import {
  cases,
  fixtureFor,
  processRss,
  setDensity,
} from './code-bundle-benchmark.mjs';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { deflateRawSync } from 'node:zlib';

const executable = process.env.CODE_BUNDLE_BROWSER;
if (!executable)
  throw new Error(
    'Set CODE_BUNDLE_BROWSER to a desktop Chrome or Edge executable.',
  );
const browserName = process.env.CODE_BUNDLE_BROWSER_NAME || 'unknown';
const sourceUrl = new URL(
  process.env.CODE_BUNDLE_BASE_URL || 'http://127.0.0.1:4173',
);
sourceUrl.searchParams.set('testCodeBundleDelta', '');
const outputPath =
  process.env.CODE_BUNDLE_OUTPUT ||
  `docs/code-output-delta-producer-${browserName}.json`;
const temp = mkdtempSync(join(tmpdir(), 'ascii-delta-producer-'));
const fixtures = join(temp, 'fixtures');
mkdirSync(fixtures);

const matrix = [];
let browser;
try {
  for (const item of cases) {
    browser = await chromium.launch({
      executablePath: executable,
      headless: true,
      args: ['--no-sandbox'],
    });
    const browserVersion = browser.version();
    let context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(sourceUrl.toString());
    const { path, info } = fixtureFor(fixtures, item);
    await page.getByLabel('Choose source video').setInputFiles(path);
    const generate = page.getByRole('button', {
      name: 'Generate ASCII code bundle',
    });
    await generate.waitFor({ state: 'visible' });
    await page.waitForFunction(
      () => {
        const button = [...document.querySelectorAll('button')].find(
          (candidate) =>
            candidate.textContent?.includes('Generate ASCII code bundle'),
        );
        return button && !button.disabled;
      },
      null,
      { timeout: 60000 },
    );
    await setDensity(page, item.density);
    const colorToggle = page.getByLabel('Source-color mode');
    if (item.color) await colorToggle.check();
    else if (await colorToggle.isChecked()) await colorToggle.uncheck();

    const rss = { peakBytes: 0, samples: 0 };
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        rss.peakBytes = Math.max(rss.peakBytes, await processRss(executable));
        rss.samples++;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();
    const start = performance.now();
    const downloadPromise = page.waitForEvent('download');
    await generate.click();
    const download = await downloadPromise;
    const generationMs = performance.now() - start;
    sampling = false;
    await sampler;
    const archive = join(temp, `${item.name}.zip`);
    await download.saveAs(archive);
    const archiveBytes = readFileSync(archive).byteLength;
    const candidateDir = join(temp, `${item.name}-extracted`);
    mkdirSync(candidateDir);
    execFileSync('unzip', ['-q', archive, '-d', candidateDir]);
    const columns = item.density;
    const rows = Math.max(
      1,
      Math.round(((columns * item.height) / item.width) * 0.55),
    );
    const cells = columns * rows;
    const deltaDataBytes = readFileSync(join(candidateDir, 'data.json'));
    const deltaData = JSON.parse(deltaDataBytes.toString('utf8'));
    const deltaChangedRows = deltaData.frames.reduce(
      (total, frame) => total + frame.rows.length,
      0,
    );
    const deltaChangedColorRows = deltaData.frames.reduce(
      (total, frame) => total + (frame.colors?.length ?? 0),
      0,
    );
    const hasColor = Boolean(deltaData.frames[0].colors);
    const bytesPerCell = hasColor ? 14 : 2;
    const deltaDecodedDataEstimateBytes =
      (deltaChangedRows + deltaChangedColorRows) * 2 * columns +
      columns * rows * bytesPerCell +
      deltaData.frames.reduce(
        (total, frame) =>
          total + (frame.rows.length + (frame.colors?.length ?? 0)) * 32 + 256,
        rows * 32 + 256,
      );
    await context.close();
    await browser.close();
    browser = await chromium.launch({
      executablePath: executable,
      headless: true,
      args: ['--no-sandbox'],
    });
    context = await browser.newContext();
    const example = await context.newPage();
    await example.addInitScript(() => {
      window.__asciiDrawCalls = 0;
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (...args) {
        window.__asciiDrawCalls++;
        return original.apply(this, args);
      };
    });
    await example.goto(`file://${join(candidateDir, 'index.html')}`);
    await example.getByRole('button', { name: 'Play' }).waitFor();
    const offlineExampleInitialDrawCalls = await example.evaluate(
      () => window.__asciiDrawCalls,
    );
    if (offlineExampleInitialDrawCalls !== cells)
      throw new Error(
        `${item.name}: offline delta example did not render one complete grid.`,
      );
    await example.close();
    const consumerDataJson = deltaDataBytes
      .toString('utf8')
      .replace(/</g, '\\u003c');
    const consumerHtml = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ASCII delta consumer</title><main id="host"></main><script type="application/json" id="data">${consumerDataJson}</script><script src="./player.js"></script><script>window.__asciiDeltaPlayer=AsciiDeltaBenchmarkPlayer.mount({container:document.getElementById('host'),data:JSON.parse(document.getElementById('data').textContent)});</script>`;
    writeFileSync(join(candidateDir, 'consumer.html'), consumerHtml);
    const consumer = await context.newPage();
    await consumer.addInitScript((frameCells) => {
      window.__asciiDrawCalls = 0;
      window.__asciiFrameTimes = [];
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (...args) {
        window.__asciiDrawCalls++;
        if (window.__asciiDrawCalls % frameCells === 0)
          window.__asciiFrameTimes.push(performance.now());
        return original.apply(this, args);
      };
    }, cells);
    const consumerStart = performance.now();
    await consumer.goto(`file://${join(candidateDir, 'consumer.html')}`);
    await consumer.getByRole('button', { name: 'Play' }).waitFor();
    const consumerStartupMs = performance.now() - consumerStart;
    const initialDrawCalls = await consumer.evaluate(
      () => window.__asciiDrawCalls,
    );
    if (initialDrawCalls !== cells)
      throw new Error(
        `${item.name}: offline delta example did not render one complete grid.`,
      );
    await consumer.evaluate(() => {
      window.__asciiFrameTimes.length = 0;
    });
    const consumerRss = { peakBytes: 0, samples: 0 };
    let sampleConsumerRss = true;
    const consumerSampler = (async () => {
      while (sampleConsumerRss) {
        consumerRss.peakBytes = Math.max(
          consumerRss.peakBytes,
          await processRss(executable),
        );
        consumerRss.samples++;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();
    await consumer.getByRole('button', { name: 'Play' }).click();
    await consumer.waitForTimeout(1200);
    const cadence = await consumer.evaluate(
      ({ initialDrawCalls, frameCells }) => {
        const drawCount = window.__asciiDrawCalls - initialDrawCalls;
        const times = window.__asciiFrameTimes;
        const gaps = times.slice(1).map((at, index) => at - times[index]);
        const sorted = [...gaps].sort((a, b) => a - b);
        return {
          framesAdvanced: Math.floor(drawCount / frameCells),
          medianGapMs: sorted.length
            ? sorted[Math.floor(sorted.length / 2)]
            : null,
          p95GapMs: sorted.length
            ? sorted[Math.ceil(sorted.length * 0.95) - 1]
            : null,
          displayedFrameCount: times.length,
        };
      },
      { initialDrawCalls, frameCells: cells },
    );
    const consumerMemory = await consumer.evaluate(() =>
      performance.memory
        ? {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
          }
        : null,
    );
    const seekTimes = Array.from(
      { length: 20 },
      (_, index) => (deltaData.duration * ((index * 7) % 19)) / 20,
    );
    const seekDurations = await consumer.evaluate((times) => {
      const durations = times.map((time) => {
        const start = performance.now();
        window.__asciiDeltaPlayer.seek(time);
        return performance.now() - start;
      });
      window.__asciiDeltaPlayer.dispose();
      return durations;
    }, seekTimes);
    const sortedSeekDurations = [...seekDurations].sort((a, b) => a - b);
    const seekP95Ms =
      sortedSeekDurations[Math.ceil(sortedSeekDurations.length * 0.95) - 1];
    sampleConsumerRss = false;
    await consumerSampler;
    await consumer.close();
    matrix.push({
      name: item.name,
      source: {
        ...info.streams[0],
        duration: Number(info.format.duration),
        sourceBytes: readFileSync(path).byteLength,
      },
      density: item.density,
      sourceColor: item.color,
      archiveBytes,
      dataJsonBytes: deltaDataBytes.byteLength,
      dataJsonDeflateBytes: deflateRawSync(deltaDataBytes).byteLength,
      deltaChangedCharacterCells: deltaChangedRows * columns,
      deltaChangedColorCells: deltaChangedColorRows * columns,
      deltaDecodedDataEstimateBytes,
      generationMs: Math.round(generationMs),
      sampledGenerationProcessPeakRssBytes: rss.peakBytes,
      generationProcessRssSampleCount: rss.samples,
      offlineExampleInitialDrawCalls,
      consumerInitialDrawCalls: initialDrawCalls,
      consumerStartupMs: Math.round(consumerStartupMs),
      cadence,
      seekP95Ms,
      consumerJsHeap: consumerMemory,
      sampledConsumerProcessPeakRssBytes: consumerRss.peakBytes,
      consumerProcessRssSampleCount: consumerRss.samples,
    });
    console.log(
      `${item.name}: ${generationMs.toFixed(0)}ms; ZIP ${archiveBytes}`,
    );
    await context.close();
    await browser.close();
    browser = undefined;
    const cpu = execFileSync(
      'bash',
      ['-lc', 'grep -m1 "model name" /proc/cpuinfo | cut -d: -f2-'],
      { encoding: 'utf8' },
    ).trim();
    const output = {
      date: new Date().toISOString(),
      browserName,
      browserVersion,
      executable,
      os: process.platform,
      arch: process.arch,
      cpu,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      processRssSamplingIntervalMs: 100,
      generatorMode:
        'development-only direct row-delta generation during source-frame sampling',
      matrix,
    };
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(outputPath, JSON.stringify(output, null, 2)),
    );
  }
} finally {
  if (browser) await browser.close();
  rmSync(temp, { recursive: true, force: true });
}
