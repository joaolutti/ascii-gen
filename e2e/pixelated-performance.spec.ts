import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Scenario = {
  name: string;
  input: string;
  mediaWidth: number;
  mediaHeight: number;
  mediaFrameRate: number;
  mediaDurationSeconds: number;
  density: 'default' | 'high';
  sourceColor: boolean;
};

const fixtureDir = join(process.cwd(), 'test-results', 'pixelated-performance');
mkdirSync(fixtureDir, { recursive: true });

function createFixture(name: string, source: string) {
  const output = join(fixtureDir, `${name}.mp4`);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    source,
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    output,
  ]);
  return output;
}

function prepareFixtures() {
  return {
    landscape12: createFixture(
      'landscape-320x180-12fps',
      'testsrc2=size=320x180:rate=12:duration=2',
    ),
    portrait12: createFixture(
      'portrait-180x320-12fps',
      'testsrc2=size=180x320:rate=12:duration=2',
    ),
    landscape30: createFixture(
      'landscape-320x180-30fps',
      'testsrc2=size=320x180:rate=30:duration=2',
    ),
    nearLimit: createFixture(
      'near-limit-1920x1080-60fps-14_9s',
      'testsrc2=size=1920x1080:rate=60:duration=14.9',
    ),
  };
}

async function setDensity(page: Page, density: Scenario['density']) {
  if (density === 'default') return;
  const control = page.getByLabel('Density');
  await control.focus();
  await control.press('End');
}

async function watchPreviewImageDraws(page: Page) {
  await page.evaluate(() => {
    const windowWithDraws = window as Window & {
      __previewDrawTimes: number[];
    };
    windowWithDraws.__previewDrawTimes = [];
    const prototype = CanvasRenderingContext2D.prototype as unknown as {
      drawImage: (...args: unknown[]) => void;
    };
    const originalDrawImage = prototype.drawImage;
    prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      ...args: unknown[]
    ) {
      if (
        this.canvas.getAttribute('aria-label') === 'ASCII preview' &&
        args[0] instanceof ImageBitmap
      ) {
        windowWithDraws.__previewDrawTimes.push(performance.now());
      }
      return originalDrawImage.apply(this, args);
    };
  });
}

async function measureWindow(
  page: Page,
  scenario: Scenario,
  repetition: number,
) {
  const report = await page.evaluate(
    async ({ scenarioName, repetitionNumber }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        'canvas[aria-label="ASCII preview"]',
      );
      const position = document.querySelector<HTMLInputElement>(
        'input[aria-label="Preview position"]',
      );
      if (!canvas || !position)
        throw new Error('Preview controls were not ready');
      const windowWithDraws = window as Window & {
        __previewDrawTimes?: number[];
      };
      const previewDrawTimes = windowWithDraws.__previewDrawTimes ?? [];
      const firstDrawIndex = previewDrawTimes.length;

      const gaps: number[] = [];
      const heapSamples: number[] = [];
      let longTaskCount = 0;
      let longTaskDurationMs = 0;
      let lastFrame = 0;
      let lastPosition = position.value;
      let positionChanges = 0;
      let finished = false;
      const start = performance.now();
      const observer =
        typeof PerformanceObserver === 'undefined'
          ? null
          : new PerformanceObserver((entries) => {
              for (const entry of entries.getEntries()) {
                longTaskCount++;
                longTaskDurationMs += entry.duration;
              }
            });
      try {
        observer?.observe({ type: 'longtask', buffered: false });
      } catch {
        // The browser may not expose Long Tasks; the rAF gap series still records stalls.
      }

      await new Promise<void>((resolve) => {
        const finish = () => {
          if (finished) return;
          finished = true;
          observer?.disconnect();
          resolve();
        };
        const tick = (now: number) => {
          if (finished) return;
          if (lastFrame) gaps.push(now - lastFrame);
          lastFrame = now;
          if (position.value !== lastPosition) {
            positionChanges++;
            lastPosition = position.value;
          }
          const memory = (
            performance as Performance & {
              memory?: { usedJSHeapSize: number };
            }
          ).memory;
          if (memory) heapSamples.push(memory.usedJSHeapSize);
          if (now - start >= 11_000) finish();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      const summarizeIntervals = (values: number[]) => {
        const sorted = [...values].sort((left, right) => left - right);
        const percentile = (fraction: number) =>
          sorted[
            Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
          ] ?? 0;
        return {
          p50: Number(percentile(0.5).toFixed(1)),
          p95: Number(percentile(0.95).toFixed(1)),
          max: Number(Math.max(...values).toFixed(1)),
        };
      };
      const drawTimes = previewDrawTimes.slice(firstDrawIndex);
      const drawGaps = drawTimes
        .slice(1)
        .map((time, index) => time - drawTimes[index]!);
      const elapsedSeconds = (performance.now() - start) / 1000;
      const heap = heapSamples.length
        ? {
            minBytes: Math.min(...heapSamples),
            maxBytes: Math.max(...heapSamples),
          }
        : null;
      return {
        scenario: scenarioName,
        repetition: repetitionNumber,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGb:
          'deviceMemory' in navigator ? navigator.deviceMemory : null,
        previewCanvasWidth: canvas.width,
        previewCanvasHeight: canvas.height,
        elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
        animationFrameHz: Number((gaps.length / elapsedSeconds).toFixed(1)),
        rAFGapMs: summarizeIntervals(gaps),
        previewImageDrawCount: drawTimes.length,
        previewImageDrawHz: Number(
          (drawTimes.length / elapsedSeconds).toFixed(1),
        ),
        previewImageGapMs: summarizeIntervals(drawGaps),
        previewPositionChanges: positionChanges,
        longTaskCount,
        longTaskDurationMs: Number(longTaskDurationMs.toFixed(1)),
        jsHeapBytes: heap,
      };
    },
    { scenarioName: scenario.name, repetitionNumber: repetition },
  );
  const browser = page.context().browser();
  return {
    ...report,
    browserEngine: browser?.browserType().name() ?? 'unknown',
    browserVersion: browser?.version() ?? 'unknown',
    source: {
      width: scenario.mediaWidth,
      height: scenario.mediaHeight,
      frameRate: scenario.mediaFrameRate,
      durationSeconds: scenario.mediaDurationSeconds,
    },
  };
}

test('records repeated preview playback measurements for the opt-in browser matrix', async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.RUN_PREVIEW_PERF !== '1',
    'Set RUN_PREVIEW_PERF=1 to run the multi-minute playback benchmark.',
  );
  test.setTimeout(480_000);

  const fixtures = prepareFixtures();
  const scenarios: Scenario[] = [
    {
      name: 'landscape-12fps-default-density',
      input: fixtures.landscape12,
      mediaWidth: 320,
      mediaHeight: 180,
      mediaFrameRate: 12,
      mediaDurationSeconds: 2,
      density: 'default',
      sourceColor: false,
    },
    {
      name: 'landscape-12fps-high-density',
      input: fixtures.landscape12,
      mediaWidth: 320,
      mediaHeight: 180,
      mediaFrameRate: 12,
      mediaDurationSeconds: 2,
      density: 'high',
      sourceColor: false,
    },
    {
      name: 'landscape-12fps-source-color',
      input: fixtures.landscape12,
      mediaWidth: 320,
      mediaHeight: 180,
      mediaFrameRate: 12,
      mediaDurationSeconds: 2,
      density: 'default',
      sourceColor: true,
    },
    {
      name: 'portrait-12fps-default-density',
      input: fixtures.portrait12,
      mediaWidth: 180,
      mediaHeight: 320,
      mediaFrameRate: 12,
      mediaDurationSeconds: 2,
      density: 'default',
      sourceColor: false,
    },
    {
      name: 'landscape-30fps-default-density',
      input: fixtures.landscape30,
      mediaWidth: 320,
      mediaHeight: 180,
      mediaFrameRate: 30,
      mediaDurationSeconds: 2,
      density: 'default',
      sourceColor: false,
    },
    {
      name: 'near-limit-1080p60-14_9s',
      input: fixtures.nearLimit,
      mediaWidth: 1920,
      mediaHeight: 1080,
      mediaFrameRate: 60,
      mediaDurationSeconds: 14.9,
      density: 'default',
      sourceColor: false,
    },
  ];
  const selectedScenario = process.env.PREVIEW_PERF_SCENARIO;
  const selectedScenarios = selectedScenario
    ? scenarios.filter((scenario) => scenario.name === selectedScenario)
    : scenarios;
  if (!selectedScenarios.length)
    throw new Error(`Unknown PREVIEW_PERF_SCENARIO: ${selectedScenario}`);
  const measurements: object[] = [];
  for (const scenario of selectedScenarios) {
    for (let repetition = 1; repetition <= 3; repetition++) {
      await page.goto('/');
      await watchPreviewImageDraws(page);
      await page
        .getByLabel('Choose source video')
        .setInputFiles(scenario.input);
      await expect(page.getByLabel('ASCII preview')).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByLabel('Play preview')).toBeVisible({
        timeout: 60_000,
      });
      await setDensity(page, scenario.density);
      if (scenario.sourceColor)
        await page.getByLabel('Source-color mode').check();
      await page.getByLabel('Play preview').click();
      await expect(page.getByLabel('Pause preview')).toBeVisible();
      await page.waitForTimeout(500);
      const measurement = await measureWindow(page, scenario, repetition);
      expect(measurement.previewImageDrawCount).toBeGreaterThan(0);
      measurements.push(measurement);
      console.log(`PREVIEW_PERF ${JSON.stringify(measurement)}`);
    }
  }

  const machine = {
    platform: process.platform,
    architecture: process.arch,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
  };
  const result = { machine, measurements };
  writeFileSync(
    join(fixtureDir, 'results.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(`PREVIEW_PERF_MACHINE ${JSON.stringify(machine)}`);
  await testInfo.attach('preview-performance.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  expect(measurements).toHaveLength(selectedScenarios.length * 3);
});
