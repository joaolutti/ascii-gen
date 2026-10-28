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
  density: 'low' | 'default' | 'high';
  sourceColor: boolean;
  mode?: 'Pixelated';
  gridStep?: 'default' | 'finest';
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
    landscape23976: createFixture(
      'landscape-320x180-23_976fps',
      'testsrc2=size=320x180:rate=24000/1001:duration=2.002',
    ),
    portrait12: createFixture(
      'portrait-180x320-12fps',
      'testsrc2=size=180x320:rate=12:duration=2',
    ),
    landscape60: createFixture(
      'landscape-320x180-60fps',
      'testsrc2=size=320x180:rate=60:duration=2',
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
  await control.press(density === 'low' ? 'Home' : 'End');
}

async function setPixelatedGridStep(
  page: Page,
  gridStep: NonNullable<Scenario['gridStep']>,
) {
  if (gridStep === 'default') return;
  const control = page.getByLabel('Grid step');
  await control.focus();
  await control.press('Home');
}

async function watchPreviewImageDraws(page: Page) {
  await page.evaluate(() => {
    const windowWithDraws = window as Window & {
      __previewDrawTimes: number[];
      __previewInstrumentationCostMs: number;
      __asciiPreviewDiagnostics: {
        requests: {
          sequence: number;
          generationId: number;
          timestamp: number;
          sentAt: number;
        }[];
        replies: {
          sequence: number;
          generationId: number;
          receivedAt: number;
          diagnostics?: {
            sampleLookupDecodeMs: number;
            drawFrameMs: number;
            bitmapCreationMs: number;
            workerTotalMs: number;
            replacedPendingPreviewCount: number;
          };
        }[];
        presentations: {
          sequence: number;
          generationId: number;
          requestToPresentationMs: number | null;
          replyToPresentationMs: number | null;
          drawImageMs: number;
        }[];
        droppedReplies: {
          sequence: number;
          generationId: number;
          reason: string;
        }[];
      };
    };
    windowWithDraws.__previewDrawTimes = [];
    windowWithDraws.__previewInstrumentationCostMs = 0;
    windowWithDraws.__asciiPreviewDiagnostics = {
      requests: [],
      replies: [],
      presentations: [],
      droppedReplies: [],
    };
    const prototype = CanvasRenderingContext2D.prototype as unknown as {
      drawImage: (...args: unknown[]) => void;
    };
    const originalDrawImage = prototype.drawImage;
    prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      ...args: unknown[]
    ) {
      const instrumentationStartedAt = performance.now();
      if (
        this.canvas.getAttribute('aria-label')?.endsWith('preview') &&
        args[0] instanceof ImageBitmap
      ) {
        windowWithDraws.__previewDrawTimes.push(performance.now());
      }
      windowWithDraws.__previewInstrumentationCostMs +=
        performance.now() - instrumentationStartedAt;
      return originalDrawImage.apply(this, args);
    };
  });
}

async function prepareScenario(
  page: Page,
  scenario: Scenario,
  withDiagnostics: boolean,
) {
  await page.goto(withDiagnostics ? '/?previewDiagnostics=1' : '/');
  await watchPreviewImageDraws(page);
  await page.getByLabel('Choose source video').setInputFiles(scenario.input);
  await expect(page.getByLabel('Play preview')).toBeVisible({
    timeout: 60_000,
  });
  if (scenario.mode === 'Pixelated') {
    await page.getByLabel('Render mode').selectOption('Pixelated');
    await expect(page.getByLabel('Pixelated preview')).toBeVisible({
      timeout: 60_000,
    });
    await setPixelatedGridStep(page, scenario.gridStep ?? 'default');
  } else {
    await expect(page.getByLabel('ASCII preview')).toBeVisible({
      timeout: 60_000,
    });
    await setDensity(page, scenario.density);
  }
  if (scenario.sourceColor) await page.getByLabel('Source-color mode').check();
  await page.getByLabel('Play preview').click();
  await expect(page.getByLabel('Pause preview')).toBeVisible();
  await page.waitForTimeout(500);
}

async function measureWindow(
  page: Page,
  scenario: Scenario,
  repetition: number,
) {
  const report = await page.evaluate(
    async ({ scenarioName, repetitionNumber }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        scenarioName.startsWith('pixelated-')
          ? 'canvas[aria-label="Pixelated preview"]'
          : 'canvas[aria-label="ASCII preview"]',
      );
      const position = document.querySelector<HTMLInputElement>(
        'input[aria-label="Preview position"]',
      );
      if (!canvas || !position)
        throw new Error('Preview controls were not ready');
      const windowWithDraws = window as Window & {
        __previewDrawTimes?: number[];
        __previewInstrumentationCostMs?: number;
        __asciiPreviewDiagnostics?: {
          sourceFrameRate?: number;
          playbackScheduler?: {
            frameIntervalMs: number;
            ticks: number;
            eligible: number;
            published: number;
          };
          requests: {
            sequence: number;
            generationId: number;
            sentAt: number;
          }[];
          replies: {
            sequence: number;
            generationId: number;
            receivedAt: number;
            diagnostics?: {
              sampleLookupDecodeMs: number;
              drawFrameMs: number;
              bitmapCreationMs: number;
              workerTotalMs: number;
              replacedPendingPreviewCount: number;
            };
          }[];
          presentations: {
            sequence: number;
            generationId: number;
            requestToPresentationMs: number | null;
            replyToPresentationMs: number | null;
            drawImageMs: number;
          }[];
          droppedReplies: {
            sequence: number;
            generationId: number;
            reason: string;
          }[];
        };
      };
      const previewDrawTimes = windowWithDraws.__previewDrawTimes ?? [];
      const diagnostics = windowWithDraws.__asciiPreviewDiagnostics;
      const firstDrawIndex = previewDrawTimes.length;
      const firstRequestIndex = diagnostics?.requests.length ?? 0;
      const firstReplyIndex = diagnostics?.replies.length ?? 0;
      const firstPresentationIndex = diagnostics?.presentations.length ?? 0;
      const firstDroppedReplyIndex = diagnostics?.droppedReplies.length ?? 0;
      const instrumentationCostAtStart =
        windowWithDraws.__previewInstrumentationCostMs ?? 0;

      const gaps: number[] = [];
      const heapSamples: number[] = [];
      let longTaskCount = 0;
      let longTaskDurationMs = 0;
      let lastFrame = 0;
      let lastPosition = position.value;
      let positionChanges = 0;
      let finished = false;
      const start = performance.now();
      let lastHeapSampleAt = start;
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
          if (memory && now - lastHeapSampleAt >= 1_000) {
            heapSamples.push(memory.usedJSHeapSize);
            lastHeapSampleAt = now;
          }
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
          count: sorted.length,
          p50: sorted.length ? Number(percentile(0.5).toFixed(1)) : null,
          p95: sorted.length ? Number(percentile(0.95).toFixed(1)) : null,
          max: sorted.length ? Number(Math.max(...values).toFixed(1)) : null,
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
      const requests = diagnostics?.requests.slice(firstRequestIndex) ?? [];
      const replies = diagnostics?.replies.slice(firstReplyIndex) ?? [];
      const presentations =
        diagnostics?.presentations.slice(firstPresentationIndex) ?? [];
      const droppedReplies =
        diagnostics?.droppedReplies.slice(firstDroppedReplyIndex) ?? [];
      const requestTimes = new Map(
        requests.map((request) => [
          `${request.generationId}:${request.sequence}`,
          request.sentAt,
        ]),
      );
      const requestToReplyGaps = replies.flatMap((reply) => {
        const requestedAt = requestTimes.get(
          `${reply.generationId}:${reply.sequence}`,
        );
        return requestedAt === undefined
          ? []
          : [reply.receivedAt - requestedAt];
      });
      const matchedReplies = replies.filter((reply) =>
        requestTimes.has(`${reply.generationId}:${reply.sequence}`),
      );
      const summarizeStage = (
        key:
          | 'sampleLookupDecodeMs'
          | 'drawFrameMs'
          | 'bitmapCreationMs'
          | 'workerTotalMs',
      ) =>
        summarizeIntervals(
          matchedReplies.flatMap((reply) =>
            reply.diagnostics ? [reply.diagnostics[key]] : [],
          ),
        );
      const workerReplacements = matchedReplies.flatMap((reply) =>
        reply.diagnostics
          ? [reply.diagnostics.replacedPendingPreviewCount]
          : [],
      );
      return {
        scenario: scenarioName,
        repetition: repetitionNumber,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGb:
          'deviceMemory' in navigator ? navigator.deviceMemory : null,
        previewCanvasWidth: canvas.width,
        previewCanvasHeight: canvas.height,
        reportedSourceFrameRate: diagnostics?.sourceFrameRate ?? null,
        playbackScheduler: diagnostics?.playbackScheduler ?? null,
        elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
        animationFrameHz: Number((gaps.length / elapsedSeconds).toFixed(1)),
        rAFGapMs: summarizeIntervals(gaps),
        previewImageDrawCount: drawTimes.length,
        previewImageDrawHz: Number(
          (drawTimes.length / elapsedSeconds).toFixed(1),
        ),
        previewImageGapMs: summarizeIntervals(drawGaps),
        requestToReplyMs: summarizeIntervals(requestToReplyGaps),
        requestToPresentationMs: summarizeIntervals(
          presentations.flatMap((item) =>
            item.requestToPresentationMs === null
              ? []
              : [item.requestToPresentationMs],
          ),
        ),
        replyToPresentationMs: summarizeIntervals(
          presentations.map((item) => item.replyToPresentationMs),
        ),
        drawImageMs: summarizeIntervals(
          presentations.map((item) => item.drawImageMs),
        ),
        workerStageMs: {
          sampleLookupDecode: summarizeStage('sampleLookupDecodeMs'),
          frameRender: summarizeStage('drawFrameMs'),
          bitmapCreation: summarizeStage('bitmapCreationMs'),
          total: summarizeStage('workerTotalMs'),
        },
        previewQueue: {
          requests: requests.length,
          replies: matchedReplies.length,
          presentations: presentations.filter(
            (item) => item.requestToPresentationMs !== null,
          ).length,
          staleReplies: droppedReplies.length,
          replacedPendingRequests:
            workerReplacements.length > 1
              ? workerReplacements.at(-1)! - workerReplacements[0]!
              : 0,
          workerBound:
            'one in-flight render plus one replaceable pending request',
        },
        instrumentationWrapperMs: Number(
          (
            (windowWithDraws.__previewInstrumentationCostMs ?? 0) -
            instrumentationCostAtStart
          ).toFixed(3),
        ),
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
    treatment:
      scenario.mode === 'Pixelated'
        ? {
            mode: scenario.mode,
            gridStep: scenario.gridStep === 'finest' ? 4 : 8,
          }
        : {
            mode: 'ASCII',
            densityColumns:
              scenario.density === 'low'
                ? 24
                : scenario.density === 'high'
                  ? 160
                  : 88,
            sourceColor: scenario.sourceColor,
          },
  };
}

async function measureRangeChangeLatency(
  page: Page,
  label: 'Preview position' | 'Brightness',
  value: number,
) {
  return page
    .getByRole('slider', { name: label })
    .evaluate(async (input, nextValue) => {
      const windowWithDraws = window as Window & {
        __previewDrawTimes?: number[];
      };
      const draws = windowWithDraws.__previewDrawTimes;
      if (!draws) throw new Error('Preview instrumentation was not installed');
      const firstDraw = draws.length;
      const startedAt = performance.now();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      if (!setter) throw new Error('Range input value setter was unavailable');
      setter.call(input, String(nextValue));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return new Promise<number>((resolve, reject) => {
        const deadline = startedAt + 2_000;
        const checkForPresentation = (now: number) => {
          if (draws.length > firstDraw) {
            resolve(now - startedAt);
            return;
          }
          if (now >= deadline) {
            reject(
              new Error(
                `${input.getAttribute('aria-label')} preview did not update`,
              ),
            );
            return;
          }
          requestAnimationFrame(checkForPresentation);
        };
        requestAnimationFrame(checkForPresentation);
      });
    }, value);
}

function summarizeLatencies(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0;
  return {
    samples: values.length,
    p50Ms: Number(percentile(0.5).toFixed(1)),
    p95Ms: Number(percentile(0.95).toFixed(1)),
    maxMs: Number(Math.max(...values).toFixed(1)),
  };
}

async function measureInteractionLatencies(page: Page, scenario: Scenario) {
  if (await page.getByLabel('Pause preview').isVisible())
    await page.getByLabel('Pause preview').click();
  await expect(page.getByLabel('Play preview')).toBeVisible();
  await page.waitForTimeout(150);
  const seek = page.getByLabel('Preview position');
  const duration = Number(await seek.getAttribute('max'));
  const seekLatencies: number[] = [];
  const appearanceLatencies: number[] = [];
  for (let index = 0; index < 20; index++) {
    const position = duration * ((((index * 7) % 20) + 1) / 21);
    seekLatencies.push(
      await measureRangeChangeLatency(page, 'Preview position', position),
    );
  }
  for (let index = 0; index < 20; index++) {
    appearanceLatencies.push(
      await measureRangeChangeLatency(page, 'Brightness', -100 + index * 10),
    );
  }
  return {
    scenario: scenario.name,
    seekLatency: summarizeLatencies(seekLatencies),
    appearanceLatency: summarizeLatencies(appearanceLatencies),
  };
}

test('records repeated preview playback measurements for the opt-in browser matrix', async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.RUN_PREVIEW_PERF !== '1',
    'Set RUN_PREVIEW_PERF=1 to run the multi-minute playback benchmark.',
  );
  test.setTimeout(900_000);

  const fixtures = prepareFixtures();
  const scenarios: Scenario[] = [
    {
      name: 'landscape-12fps-low-density',
      input: fixtures.landscape12,
      mediaWidth: 320,
      mediaHeight: 180,
      mediaFrameRate: 12,
      mediaDurationSeconds: 2,
      density: 'low',
      sourceColor: false,
    },
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
      name: 'landscape-23_976fps-default-density',
      input: fixtures.landscape23976,
      mediaWidth: 320,
      mediaHeight: 180,
      mediaFrameRate: 24000 / 1001,
      mediaDurationSeconds: 2.002,
      density: 'default',
      sourceColor: false,
    },
    {
      name: 'landscape-60fps-default-density',
      input: fixtures.landscape60,
      mediaWidth: 320,
      mediaHeight: 180,
      mediaFrameRate: 60,
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
    {
      name: 'pixelated-landscape-default-gridstep',
      input: fixtures.landscape12,
      mediaWidth: 320,
      mediaHeight: 180,
      mediaFrameRate: 12,
      mediaDurationSeconds: 2,
      density: 'default',
      sourceColor: false,
      mode: 'Pixelated',
      gridStep: 'default',
    },
    {
      name: 'pixelated-landscape-finest-gridstep',
      input: fixtures.landscape12,
      mediaWidth: 320,
      mediaHeight: 180,
      mediaFrameRate: 12,
      mediaDurationSeconds: 2,
      density: 'default',
      sourceColor: false,
      mode: 'Pixelated',
      gridStep: 'finest',
    },
    {
      name: 'pixelated-portrait-default-gridstep',
      input: fixtures.portrait12,
      mediaWidth: 180,
      mediaHeight: 320,
      mediaFrameRate: 12,
      mediaDurationSeconds: 2,
      density: 'default',
      sourceColor: false,
      mode: 'Pixelated',
      gridStep: 'default',
    },
    {
      name: 'pixelated-portrait-finest-gridstep',
      input: fixtures.portrait12,
      mediaWidth: 180,
      mediaHeight: 320,
      mediaFrameRate: 12,
      mediaDurationSeconds: 2,
      density: 'default',
      sourceColor: false,
      mode: 'Pixelated',
      gridStep: 'finest',
    },
  ];
  const selectedScenario = process.env.PREVIEW_PERF_SCENARIO;
  const selectedScenarioNames = selectedScenario
    ?.split(',')
    .map((name) => name.trim());
  const selectedScenarios = selectedScenario
    ? scenarios.filter((scenario) => selectedScenarioNames?.includes(scenario.name))
    : scenarios;
  if (!selectedScenarios.length)
    throw new Error(`Unknown PREVIEW_PERF_SCENARIO: ${selectedScenario}`);
  const measurements: object[] = [];
  for (const scenario of selectedScenarios) {
    for (let repetition = 1; repetition <= 3; repetition++) {
      await prepareScenario(page, scenario, true);
      const measurement = await measureWindow(page, scenario, repetition);
      expect(measurement.previewImageDrawCount).toBeGreaterThan(0);
      const interactions =
        repetition === 3
          ? await measureInteractionLatencies(page, scenario)
          : undefined;
      const record = {
        ...measurement,
        ...(interactions ? { interactions } : {}),
      };
      measurements.push(record);
      console.log(`PREVIEW_PERF ${JSON.stringify(record)}`);
    }
  }

  let instrumentationCalibration: object | undefined;
  const calibrationScenario = selectedScenarios.find(
    (scenario) => scenario.name === 'landscape-12fps-default-density',
  );
  if (calibrationScenario) {
    const controlMeasurements: object[] = [];
    for (let repetition = 1; repetition <= 3; repetition++) {
      await prepareScenario(page, calibrationScenario, false);
      const measurement = await measureWindow(
        page,
        calibrationScenario,
        repetition,
      );
      controlMeasurements.push(measurement);
      console.log(`PREVIEW_PERF_UNINSTRUMENTED ${JSON.stringify(measurement)}`);
    }
    const readDrawRates = (records: object[]) =>
      records.map(
        (record) =>
          (record as { previewImageDrawHz: number }).previewImageDrawHz,
      );
    const median = (values: number[]) => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    const instrumentedMeasurements = measurements.filter(
      (record) =>
        (record as { scenario: string }).scenario === calibrationScenario.name,
    );
    const instrumentedDrawHz = median(readDrawRates(instrumentedMeasurements));
    const uninstrumentedDrawHz = median(readDrawRates(controlMeasurements));
    instrumentationCalibration = {
      scenario: calibrationScenario.name,
      repetitions: 3,
      observationSeconds: 11,
      mode: 'same canvas draw hook; worker and app diagnostics disabled',
      instrumentedDrawHz,
      uninstrumentedDrawHz,
      drawRateDifferencePercent: Number(
        (
          ((instrumentedDrawHz - uninstrumentedDrawHz) / uninstrumentedDrawHz) *
          100
        ).toFixed(1),
      ),
      drawHookSelfTimeMs: instrumentedMeasurements.map(
        (record) =>
          (record as { instrumentationWrapperMs: number })
            .instrumentationWrapperMs,
      ),
      limitations:
        'The comparison estimates added worker/app diagnostic overhead; the canvas hook remains enabled in both modes and reports its measured self-time separately.',
    };
  }

  const machine = {
    platform: process.platform,
    architecture: process.arch,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
  };
  const result = { machine, measurements, instrumentationCalibration };
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
