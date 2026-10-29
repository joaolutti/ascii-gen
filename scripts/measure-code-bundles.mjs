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

function deltaExample(data, delta) {
  const metadata = JSON.stringify({
    width: data.width,
    height: data.height,
    columns: data.columns,
    rows: data.rows,
    cellWidth: data.cellWidth,
    cellHeight: data.cellHeight,
    fontSize: data.fontSize,
    foreground: data.foreground,
    background: data.background,
    duration: data.duration,
  }).replace(/</g, '\\u003c');
  const frames = JSON.stringify(delta).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ASCII delta benchmark</title><style>body{margin:2rem;background:${data.background};color:${data.foreground};font-family:system-ui,sans-serif}canvas{display:block;max-width:100%;height:auto}button{font:inherit}</style><main><canvas aria-label="ASCII video frame" width="${data.width}" height="${data.height}"></canvas><button type="button">Play</button></main><script type="application/json" id="meta">${metadata}</script><script type="application/json" id="frames">${frames}</script><script>
const meta=JSON.parse(document.getElementById('meta').textContent),frames=JSON.parse(document.getElementById('frames').textContent),canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),button=document.querySelector('button');
ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.font=meta.fontSize+'px monospace';let rows=Array(meta.rows).fill(' '.repeat(meta.columns)),colors=Array(meta.rows).fill('000000'.repeat(meta.columns)),index=-1,playing=false,elapsed=0,startedAt=0,raf=0;
function reconstruct(next){if(next<index){rows=Array(meta.rows).fill(' '.repeat(meta.columns));colors=Array(meta.rows).fill('000000'.repeat(meta.columns));index=-1}while(index<next){index++;for(const [y,row] of frames[index].rows)rows[y]=row;if(frames[index].colors)for(const [y,row] of frames[index].colors)colors[y]=row}}
function drawAt(time){let lo=0,hi=frames.length;while(lo<hi){const mid=(lo+hi)>>>1;if(frames[mid].t<=time)lo=mid+1;else hi=mid}const next=Math.max(0,lo-1);if(next===index)return;reconstruct(next);ctx.fillStyle=meta.background;ctx.fillRect(0,0,meta.width,meta.height);for(let y=0;y<meta.rows;y++)for(let x=0;x<meta.columns;x++){ctx.fillStyle=frames[next].colors?'#'+colors[y].slice(x*6,x*6+6):meta.foreground;ctx.fillText(rows[y][x],x*meta.cellWidth,(y+1)*meta.cellHeight)}}
function seek(time){elapsed=Math.max(0,Math.min(meta.duration,time));if(playing)startedAt=performance.now();drawAt(elapsed)}window.deltaSeek=seek;
function tick(now){if(!playing)return;let time=elapsed+(now-startedAt)/1000;if(time>=meta.duration){time%=meta.duration;elapsed=time;startedAt=now}drawAt(time);raf=requestAnimationFrame(tick)}
button.addEventListener('click',()=>{playing=!playing;button.textContent=playing?'Pause':'Play';if(playing){if(elapsed>=meta.duration)elapsed=0;startedAt=performance.now();raf=requestAnimationFrame(tick)}else{elapsed=Math.min(meta.duration,elapsed+(performance.now()-startedAt)/1000);cancelAnimationFrame(raf);drawAt(elapsed)}});drawAt(0);
</script>`;
}

function singleFileZipBytes(name, content) {
  const nameBytes = Buffer.byteLength(name);
  const compressedBytes = deflateRawSync(Buffer.from(content)).byteLength;
  return 30 + nameBytes + compressedBytes + 46 + nameBytes + 22;
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
    await browser.close();
    browser = undefined;
    rss.peakBytes = 0;
    rss.samples = 0;
    browser = await chromium.launch({
      executablePath: executable,
      headless: true,
      args: ['--no-sandbox'],
    });
    const consumerContext = await browser.newContext();
    const consumer = await consumerContext.newPage();
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
    const consumerPeakRssBytes = rss.peakBytes;
    const consumerRssSampleCount = rss.samples;
    const seekTimes = Array.from(
      { length: 20 },
      (_, index) => (data.duration * ((index * 7) % 19)) / 20,
    );
    await consumer.evaluate((consumerData) => {
      const host = document.createElement('div');
      host.style.width = '1px';
      document.body.append(host);
      window.__asciiSeekPlayer = window.AsciiVideoPlayer.mount({
        container: host,
        data: consumerData,
      });
    }, data);
    const seekDurations = await consumer.evaluate((times) => {
      const durations = times.map((time) => {
        const started = performance.now();
        window.__asciiSeekPlayer.seek(time);
        return performance.now() - started;
      });
      window.__asciiSeekPlayer.dispose();
      return durations;
    }, seekTimes);
    const sortedSeekDurations = [...seekDurations].sort((a, b) => a - b);
    const seekP95Ms =
      sortedSeekDurations[Math.ceil(sortedSeekDurations.length * 0.95) - 1];
    await consumer.close();
    const deltaHtml = deltaExample(data, delta);
    writeFileSync(join(dir, 'delta.html'), deltaHtml);
    await browser.close();
    browser = undefined;

    rss.peakBytes = 0;
    rss.samples = 0;
    browser = await chromium.launch({
      executablePath: executable,
      headless: true,
      args: ['--no-sandbox'],
    });
    const deltaContext = await browser.newContext();
    const deltaConsumer = await deltaContext.newPage();
    await deltaConsumer.addInitScript((cells) => {
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
    const deltaConsumerStart = performance.now();
    await deltaConsumer.goto(`file://${join(dir, 'delta.html')}`);
    await deltaConsumer.getByRole('button', { name: 'Play' }).waitFor();
    const deltaConsumerStartupMs = performance.now() - deltaConsumerStart;
    const deltaInitialDraws = await deltaConsumer.evaluate(
      () => window.__asciiDrawCalls,
    );
    await deltaConsumer.evaluate(() => {
      window.__asciiFrameTimes.length = 0;
    });
    await deltaConsumer.getByRole('button', { name: 'Play' }).click();
    await deltaConsumer.waitForTimeout(1200);
    const deltaCadence = await deltaConsumer.evaluate(
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
      { initialDraws: deltaInitialDraws, cells: data.rows * data.columns },
    );
    const deltaMemory = await deltaConsumer.evaluate(() =>
      performance.memory
        ? {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
          }
        : null,
    );
    const deltaConsumerPeakRssBytes = rss.peakBytes;
    const deltaConsumerRssSampleCount = rss.samples;
    const deltaSeekDurations = await deltaConsumer.evaluate((times) => {
      const durations = times.map((time) => {
        const started = performance.now();
        window.deltaSeek(time);
        return performance.now() - started;
      });
      return durations;
    }, seekTimes);
    const sortedDeltaSeekDurations = [...deltaSeekDurations].sort(
      (a, b) => a - b,
    );
    const deltaSeekP95Ms =
      sortedDeltaSeekDurations[
        Math.ceil(sortedDeltaSeekDurations.length * 0.95) - 1
      ];
    await deltaContext.close();
    const hasColor = Boolean(data.frames[0].colors);
    const bytesPerCell = hasColor ? 14 : 2;
    const fullDecodedFrameDataEstimateBytes =
      data.columns * data.rows * data.frames.length * bytesPerCell +
      data.frames.length * (data.rows * 32 + 256);
    const deltaCharacterCells = delta.reduce(
      (total, frame) => total + frame.rows.length * data.columns,
      0,
    );
    const deltaColorCells = delta.reduce(
      (total, frame) => total + (frame.colors?.length ?? 0) * data.columns,
      0,
    );
    const deltaDecodedFrameDataEstimateBytes =
      (deltaCharacterCells + deltaColorCells) * 2 +
      data.columns * data.rows * bytesPerCell +
      delta.reduce(
        (total, frame) =>
          total + (frame.rows.length + (frame.colors?.length ?? 0)) * 32 + 256,
        data.rows * 32 + 256,
      );
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
      deltaPrototypeHtmlBytes: Buffer.byteLength(deltaHtml),
      deltaPrototypeSingleFileZipBytes: singleFileZipBytes(
        'index.html',
        deltaHtml,
      ),
      deltaChangedCharacterCells: deltaCharacterCells,
      deltaChangedColorCells: deltaColorCells,
      fullDecodedFrameDataEstimateBytes,
      deltaDecodedFrameDataEstimateBytes,
      archiveBytes: readFileSync(archive).byteLength,
      generationMs: Math.round(generationMs),
      consumerStartupMs: Math.round(consumerStartupMs),
      cadence,
      seekP95Ms,
      consumerJsHeap: memory,
      deltaConsumerStartupMs: Math.round(deltaConsumerStartupMs),
      deltaCadence,
      deltaSeekP95Ms,
      deltaConsumerJsHeap: deltaMemory,
      sampledGenerationProcessPeakRssBytes: generationPeakRssBytes,
      generationProcessRssSampleCount: generationRssSampleCount,
      sampledConsumerProcessPeakRssBytes: consumerPeakRssBytes,
      consumerProcessRssSampleCount: consumerRssSampleCount,
      sampledDeltaConsumerProcessPeakRssBytes: deltaConsumerPeakRssBytes,
      deltaConsumerProcessRssSampleCount: deltaConsumerRssSampleCount,
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
