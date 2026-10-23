import { expect, test } from '@playwright/test';

type Observation = {
  cadenceFps: number;
  changedFrames: number;
  medianFrameGapMs: number | null;
  p95FrameGapMs: number | null;
  heapStartBytes: number | null;
  heapEndBytes: number | null;
};

async function observeMotion(
  page: import('@playwright/test').Page,
  durationMs: number,
): Promise<Observation> {
  return page.getByLabel('Pixelated preview').evaluate(
    (element, duration) =>
      new Promise<Observation>((resolve) => {
        const canvas = element as HTMLCanvasElement;
        const context = canvas.getContext('2d')!;
        const gaps: number[] = [];
        const start = performance.now();
        const heapStart = performance.memory?.usedJSHeapSize ?? null;
        let previousHash = '';
        let previousChange = start;
        let changedFrames = 0;
        function sample(now: number) {
          const { data } = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          );
          let hash = '';
          for (let index = 0; index < data.length; index += 127)
            hash += String.fromCharCode(data[index]);
          if (previousHash && hash !== previousHash) {
            gaps.push(now - previousChange);
            previousChange = now;
            changedFrames++;
          }
          previousHash = hash;
          if (now - start >= duration) {
            gaps.sort((a, b) => a - b);
            const percentile = (value: number) =>
              gaps.length ? gaps[Math.ceil(value * gaps.length) - 1] : null;
            resolve({
              cadenceFps: changedFrames / (duration / 1000),
              changedFrames,
              medianFrameGapMs: percentile(0.5),
              p95FrameGapMs: percentile(0.95),
              heapStartBytes: heapStart,
              heapEndBytes: performance.memory?.usedJSHeapSize ?? null,
            });
            return;
          }
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      }),
    durationMs,
  );
}

async function previewHash(page: import('@playwright/test').Page) {
  return page.getByLabel('Pixelated preview').evaluate((element) => {
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

async function setRange(
  page: import('@playwright/test').Page,
  label: string,
  value: number,
) {
  const slider = page.getByRole('slider', { name: label });
  const box = await slider.boundingBox();
  if (!box) throw new Error(`${label} slider is not visible`);
  const min = Number(await slider.getAttribute('min'));
  const max = Number(await slider.getAttribute('max'));
  await slider.click({
    position: {
      x: Math.max(
        1,
        Math.min(box.width - 1, ((value - min) / (max - min)) * box.width),
      ),
      y: box.height / 2,
    },
  });
  const step = Number((await slider.getAttribute('step')) ?? 1);
  const actual = Number(await slider.inputValue());
  const correction = Math.round((value - actual) / step);
  for (let index = 0; index < Math.abs(correction); index++)
    await slider.press(correction > 0 ? 'ArrowRight' : 'ArrowLeft');
}

test('records Pixelated preview performance on the bundled moving fixture', async ({
  page,
}) => {
  test.skip(
    process.env.PIXELATED_PERF !== '1',
    'Set PIXELATED_PERF=1 to run the hardware-sensitive preview measurement.',
  );
  test.setTimeout(60_000);
  await page.goto('/');
  await page
    .getByLabel('Choose source video')
    .setInputFiles('public/fixtures/landscape.mp4');
  await expect(page.getByLabel('ASCII preview')).toBeVisible();
  await page.getByLabel('Render mode').selectOption('Pixelated');
  const gridStep = page.getByRole('slider', { name: 'Grid step' });
  await expect(gridStep).toHaveValue('8');
  await page.getByRole('button', { name: 'Play preview' }).click();
  await page.waitForTimeout(500);
  const defaultGrid = await observeMotion(page, 4_000);
  await page.getByRole('button', { name: 'Pause preview' }).click();

  const beforeSeek = await previewHash(page);
  const seekStart = Date.now();
  await page.getByRole('slider', { name: 'Preview position' }).press('End');
  await expect.poll(() => previewHash(page)).not.toBe(beforeSeek);
  const seekLatencyMs = Date.now() - seekStart;

  const beforeAppearance = await previewHash(page);
  const appearanceStart = Date.now();
  await setRange(page, 'Brightness', 25);
  await expect.poll(() => previewHash(page)).not.toBe(beforeAppearance);
  const appearanceLatencyMs = Date.now() - appearanceStart;

  await setRange(page, 'Grid step', 4);
  await page.getByRole('button', { name: 'Play preview' }).click();
  await page.waitForTimeout(500);
  const finestGrid = await observeMotion(page, 4_000);
  await page.getByRole('button', { name: 'Pause preview' }).click();
  console.log(
    'PIXELATED_PERF ' +
      JSON.stringify({
        browser: await page.evaluate(() => navigator.userAgent),
        source: { file: 'landscape.mp4', width: 320, height: 180, fps: 12 },
        measurementWindowMs: 4_000,
        defaultGridStepPx: 8,
        finestGridStepPx: 4,
        defaultGrid,
        finestGrid,
        seekLatencyMs,
        appearanceLatencyMs,
      }),
  );
});
