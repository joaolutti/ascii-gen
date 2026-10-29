/* global CanvasRenderingContext2D, document, window */
import { chromium } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const executable = process.env.CODE_BUNDLE_BROWSER;
if (!executable)
  throw new Error(
    'Set CODE_BUNDLE_BROWSER to a desktop Chrome or Edge executable.',
  );
const browserName = process.env.CODE_BUNDLE_BROWSER_NAME || 'unknown';
const baseUrl = process.env.CODE_BUNDLE_BASE_URL || 'http://127.0.0.1:4173';
const outputPath =
  process.env.CODE_BUNDLE_OUTPUT || `docs/code-output-${browserName}.json`;
const temp = mkdtempSync(join(tmpdir(), 'ascii-code-matrix-'));
const fixtures = join(temp, 'fixtures');
mkdirSync(fixtures);

const cases = [
  {
    name: 'landscape-short-low',
    width: 320,
    height: 180,
    fps: '12',
    duration: 2,
    density: 24,
    color: false,
  },
  {
    name: 'landscape-short-default',
    width: 320,
    height: 180,
    fps: '12',
    duration: 2,
    density: 88,
    color: false,
  },
  {
    name: 'landscape-short-high',
    width: 320,
    height: 180,
    fps: '12',
    duration: 2,
    density: 160,
    color: false,
  },
  {
    name: 'portrait-high',
    width: 180,
    height: 320,
    fps: '12',
    duration: 4,
    density: 160,
    color: false,
  },
  {
    name: 'minimum-aspect-high',
    width: 360,
    height: 640,
    fps: '12',
    duration: 4,
    density: 160,
    color: false,
  },
  {
    name: 'source-color-default',
    width: 320,
    height: 180,
    fps: '12',
    duration: 4,
    density: 88,
    color: true,
  },
  {
    name: 'fractional-cadence',
    width: 320,
    height: 180,
    fps: '24000/1001',
    duration: 4,
    density: 88,
    color: false,
  },
  {
    name: 'capped-cadence',
    width: 320,
    height: 180,
    fps: '60',
    duration: 2,
    density: 88,
    color: false,
  },
  {
    name: 'near-15-second',
    width: 320,
    height: 180,
    fps: '30000/1001',
    duration: 14.9,
    density: 88,
    color: false,
  },
];

function fixtureFor(item) {
  const path = join(fixtures, `${item.name}.mp4`);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${item.width}x${item.height}:rate=${item.fps}:duration=${item.duration}`,
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'ultrafast',
    '-crf',
    '28',
    path,
  ]);
  const info = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,avg_frame_rate,nb_frames',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8' },
    ),
  );
  return { path, info };
}

async function setDensity(page, value) {
  const slider = page.getByLabel('Density');
  const current = Number(await slider.inputValue());
  if (current === value) return;
  await slider.focus();
  const steps = Math.abs(value - current) / 8;
  if (!Number.isInteger(steps)) throw new Error(`Invalid Density: ${value}.`);
  for (let index = 0; index < steps; index++)
    await slider.press(value < current ? 'ArrowLeft' : 'ArrowRight');
  if (Number(await slider.inputValue()) !== value)
    throw new Error(`Could not set Density to ${value}.`);
}

async function processRss() {
  const result = spawnSync('ps', ['-eo', 'rss,args'], { encoding: 'utf8' });
  return (
    result.stdout
      .split('\n')
      .slice(1)
      .filter((line) => line.includes(executable))
      .reduce(
        (sum, line) => sum + Number(line.trim().split(/\s+/)[0] || 0),
        0,
      ) * 1024
  );
}

const rss = { peakBytes: 0, samples: 0 };
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    rss.peakBytes = Math.max(rss.peakBytes, await processRss());
    rss.samples++;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
})();

const localOrigin = new URL(baseUrl).origin;
const results = [];
let browser;
try {
  for (const item of cases) {
    browser = await chromium.launch({
      executablePath: executable,
      headless: true,
      args: ['--no-sandbox'],
    });
    const browserVersion = browser.version();
    const context = await browser.newContext({ acceptDownloads: true });
    await context.route(/^https?:\/\//, (route) =>
      new URL(route.request().url()).origin === localOrigin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    await page.goto(baseUrl);
    const { path, info } = fixtureFor(item);
    await page.getByLabel('Choose source video').setInputFiles(path);
    await page
      .getByRole('button', { name: 'Generate ASCII code bundle' })
      .waitFor({ state: 'visible' });
    await page.waitForFunction(
      () => {
        const button = [...document.querySelectorAll('button')].find((b) =>
          b.textContent?.includes('Generate ASCII code bundle'),
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
    rss.peakBytes = 0;
    rss.samples = 0;
    const startedAt = performance.now();
    const downloadPromise = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Generate ASCII code bundle' })
      .click();
    const download = await downloadPromise;
    const generationMs = performance.now() - startedAt;
    const generationPeakRssBytes = rss.peakBytes;
    const generationRssSampleCount = rss.samples;
    const archive = join(temp, `${item.name}.zip`);
    await download.saveAs(archive);
    const dir = join(temp, item.name);
    mkdirSync(dir);
    execFileSync('unzip', ['-q', archive, '-d', dir]);
    const dataBytes = readFileSync(join(dir, 'data.json'));
    const data = JSON.parse(dataBytes.toString('utf8'));
    const delta = data.frames.map((frame, index) => ({
      t: frame.timestamp,
      d: frame.duration,
      rows: frame.rows.flatMap((row, y) =>
        index === 0 || row !== data.frames[index - 1].rows[y] ? [[y, row]] : [],
      ),
      ...(frame.colors
        ? {
            colors: frame.colors.flatMap((row, y) =>
              index === 0 || row !== data.frames[index - 1].colors[y]
                ? [[y, row]]
                : [],
            ),
          }
        : {}),
    }));
    const compactDelta = Buffer.from(JSON.stringify(delta));
    rss.peakBytes = 0;
    rss.samples = 0;
    const consumer = await context.newPage();
    await consumer.addInitScript((cells) => {
      window.__asciiDrawCalls = 0;
      window.__asciiFrameTimes = [];
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (...args) {
        window.__asciiDrawCalls++;
        if (window.__asciiDrawCalls % cells === 0)
          window.__asciiFrameTimes.push(performance.now());
        return original.apply(this, args);
      };
    }, data.rows * data.columns);
    const consumerStart = performance.now();
    await consumer.goto(`file://${join(dir, 'index.html')}`);
    await consumer.getByRole('button', { name: 'Play' }).waitFor();
    const consumerStartupMs = performance.now() - consumerStart;
    const initialDraws = await consumer.evaluate(() => window.__asciiDrawCalls);
    await consumer.evaluate(() => {
      window.__asciiFrameTimes.length = 0;
    });
    await consumer.getByRole('button', { name: 'Play' }).click();
    await consumer.waitForTimeout(1200);
    const cadence = await consumer.evaluate(
      ({ initialDraws, cells }) => {
        const drawCount = window.__asciiDrawCalls - initialDraws;
        const gaps = window.__asciiFrameTimes
          .slice(1)
          .map((at, index) => at - window.__asciiFrameTimes[index]);
        const sorted = [...gaps].sort((a, b) => a - b);
        return {
          framesAdvanced: Math.floor(drawCount / cells),
          medianGapMs: sorted.length
            ? sorted[Math.floor(sorted.length / 2)]
            : null,
          p95GapMs: sorted.length
            ? sorted[Math.ceil(sorted.length * 0.95) - 1]
            : null,
          displayedFrameCount: window.__asciiFrameTimes.length,
        };
      },
      { initialDraws, cells: data.rows * data.columns },
    );
    const memory = await consumer.evaluate(() =>
      performance.memory
        ? {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
          }
        : null,
    );
    await consumer.close();
    results.push({
      name: item.name,
      source: {
        ...info.streams[0],
        duration: Number(info.format.duration),
        sourceBytes: readFileSync(path).byteLength,
      },
      density: item.density,
      sourceColor: item.color,
      grid: `${data.columns}x${data.rows}`,
      frames: data.frames.length,
      totalCells: data.columns * data.rows * data.frames.length,
      dataJsonBytes: dataBytes.byteLength,
      dataDeflateBytes: deflateRawSync(dataBytes).byteLength,
      deltaJsonBytes: compactDelta.byteLength,
      deltaDeflateBytes: deflateRawSync(compactDelta).byteLength,
      archiveBytes: readFileSync(archive).byteLength,
      generationMs: Math.round(generationMs),
      consumerStartupMs: Math.round(consumerStartupMs),
      cadence,
      consumerJsHeap: memory,
      sampledGenerationProcessPeakRssBytes: generationPeakRssBytes,
      generationProcessRssSampleCount: generationRssSampleCount,
      sampledConsumerProcessPeakRssBytes: rss.peakBytes,
      consumerProcessRssSampleCount: rss.samples,
    });
    writeFileSync(
      outputPath,
      JSON.stringify(
        {
          date: new Date().toISOString(),
          browserName,
          browserVersion,
          executable,
          os: process.platform,
          arch: process.arch,
          cpu: execFileSync(
            'bash',
            ['-lc', 'grep -m1 "model name" /proc/cpuinfo | cut -d: -f2-'],
            { encoding: 'utf8' },
          ).trim(),
          logicalCpus: cpus().length,
          totalMemoryBytes: totalmem(),
          viewport: { width: 1280, height: 720 },
          processRssSamplingIntervalMs: 100,
          matrix: results,
        },
        null,
        2,
      ),
    );
    console.log(
      `${item.name}: ${generationMs.toFixed(0)}ms; ZIP ${results.at(-1).archiveBytes}; startup ${consumerStartupMs.toFixed(0)}ms`,
    );
    await browser.close();
    browser = undefined;
  }
} finally {
  sampling = false;
  await sampler;
  if (browser) await browser.close();
  rmSync(temp, { recursive: true, force: true });
}
