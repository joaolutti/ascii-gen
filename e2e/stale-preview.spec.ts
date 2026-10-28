import { expect, test } from '@playwright/test';

async function previewHash(page: import('@playwright/test').Page) {
  return page
    .locator('canvas[aria-label="ASCII preview"], canvas[aria-label="Pixelated preview"]')
    .evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      let hash = 0;
      for (let index = 0; index < data.length; index += 97)
        hash = (hash * 31 + data[index]!) >>> 0;
      return hash;
    });
}

async function seekTo(page: import('@playwright/test').Page, seconds: number) {
  await page.getByRole('slider', { name: 'Preview position' }).evaluate((element, value) => {
    const slider = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, String(value));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
}

test('a late seek frame cannot replace the selected moment and treatment', async ({ page }) => {
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage')!;
    Object.defineProperty(Worker.prototype, 'onmessage', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() { return descriptor.get!.call(this); },
      set(handler: ((event: MessageEvent) => void) | null) {
        descriptor.set!.call(this, handler && function (this: Worker, event: MessageEvent) {
          if (event.data?.type !== 'preview' || event.data.sequence === 0) {
            handler.call(this, event);
            return;
          }
          const delay = event.data.sequence === 1 ? 900 : 2_000;
          if (event.data.sequence === 1)
            (window as Window & { stalePreviewHeld?: boolean }).stalePreviewHeld = true;
          window.setTimeout(() => handler.call(this, event), delay);
        });
      },
    });
  });

  await page.goto('/');
  await page.getByLabel('Choose source video').setInputFiles('public/fixtures/landscape.mp4');
  await expect(page.getByRole('slider', { name: 'Preview position' })).toBeVisible();
  const initialHash = await previewHash(page);
  await seekTo(page, 0.2);
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { stalePreviewHeld?: boolean }).stalePreviewHeld))).toBe(true);
  await seekTo(page, 1.5);
  await page.getByLabel('Render mode').selectOption('Pixelated');
  await page.waitForTimeout(1_000);
  expect(await previewHash(page)).toBe(initialHash);
  await expect.poll(() => previewHash(page), { timeout: 5_000 }).not.toBe(initialHash);
});
