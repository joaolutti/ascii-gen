function safeJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export type DeltaBenchmarkData = {
  version: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  fontSize: number;
  foreground: string;
  background: string;
  duration: number;
  frames: Array<{
    t: number;
    d: number;
    rows: Array<[number, string]>;
    colors?: Array<[number, string]>;
  }>;
};

const deltaBenchmarkPlayer = `(function (global) {
  'use strict';
  function mount(options) {
    const data = options && options.data;
    if (!options || !options.container || !data || data.version !== 1 ||
      !Array.isArray(data.frames) || data.frames.length < 1 ||
      !Number.isFinite(data.duration) || data.duration <= 0) {
      throw new Error('Invalid delta benchmark data.');
    }
    const container = options.container;
    const doc = container.ownerDocument;
    const wrapper = doc.createElement('div');
    const canvas = doc.createElement('canvas');
    const controls = doc.createElement('div');
    const button = doc.createElement('button');
    const label = doc.createElement('label');
    const loop = doc.createElement('input');
    canvas.width = data.width;
    canvas.height = data.height;
    canvas.setAttribute('aria-label', options.label || 'ASCII video frame');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable.');
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.font = data.fontSize + 'px monospace';
    button.type = 'button';
    button.textContent = 'Play';
    loop.type = 'checkbox';
    loop.checked = options.loop !== false;
    loop.setAttribute('aria-label', 'Loop playback');
    label.append(loop, doc.createTextNode(' Loop'));
    controls.style.cssText = 'display:flex;align-items:center;gap:.5rem;margin-top:.5rem;';
    controls.append(button, label);
    wrapper.style.cssText = 'width:100%;';
    canvas.style.cssText = 'display:block;box-sizing:border-box;margin:0;overflow:hidden;background-color:' + data.background + ';';
    wrapper.append(canvas, controls);
    container.append(wrapper);
    let rows = Array(data.rows).fill(' '.repeat(data.columns));
    let colors = Array(data.rows).fill('000000'.repeat(data.columns));
    let index = -1;
    let playing = false;
    let disposed = false;
    let elapsed = 0;
    let startedAt = 0;
    let raf = 0;
    let resizeObserver = null;
    const reconstruct = (next) => {
      if (next < index) {
        rows = Array(data.rows).fill(' '.repeat(data.columns));
        colors = Array(data.rows).fill('000000'.repeat(data.columns));
        index = -1;
      }
      while (index < next) {
        index++;
        const frame = data.frames[index];
        for (const [y, row] of frame.rows) rows[y] = row;
        if (frame.colors) for (const [y, row] of frame.colors) colors[y] = row;
      }
    };
    const renderAt = (time) => {
      let low = 0, high = data.frames.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (data.frames[mid].t <= time) low = mid + 1;
        else high = mid;
      }
      const next = Math.max(0, low - 1);
      if (next === index) return;
      reconstruct(next);
      context.fillStyle = data.background;
      context.fillRect(0, 0, data.width, data.height);
      for (let y = 0; y < data.rows; y++) for (let x = 0; x < data.columns; x++) {
        context.fillStyle = data.frames[next].colors
          ? '#' + colors[y].slice(x * 6, x * 6 + 6)
          : data.foreground;
        context.fillText(rows[y][x], x * data.cellWidth, (y + 1) * data.cellHeight);
      }
    };
    const syncSize = () => {
      const scale = Math.min(1, wrapper.clientWidth / data.width);
      canvas.style.width = (data.width * scale) + 'px';
      canvas.style.height = (data.height * scale) + 'px';
    };
    if (typeof global.ResizeObserver === 'function') {
      resizeObserver = new global.ResizeObserver(syncSize);
      resizeObserver.observe(container);
    }
    syncSize();
    const stop = () => { if (raf) global.cancelAnimationFrame(raf); raf = 0; };
    const pause = () => {
      if (disposed || !playing) return;
      elapsed = Math.min(data.duration, elapsed + (global.performance.now() - startedAt) / 1000);
      playing = false;
      stop();
      button.textContent = 'Play';
      renderAt(elapsed);
    };
    const play = () => {
      if (disposed || playing) return;
      if (elapsed >= data.duration) elapsed = 0;
      playing = true;
      startedAt = global.performance.now();
      button.textContent = 'Pause';
      raf = global.requestAnimationFrame(tick);
    };
    function tick(now) {
      if (!playing || disposed) return;
      const time = elapsed + (now - startedAt) / 1000;
      if (time >= data.duration) {
        if (!loop.checked) {
          elapsed = data.duration;
          playing = false;
          button.textContent = 'Play';
          renderAt(elapsed);
          return;
        }
        elapsed = time % data.duration;
        startedAt = now;
        renderAt(elapsed);
      } else renderAt(time);
      raf = global.requestAnimationFrame(tick);
    }
    const onClick = () => playing ? pause() : play();
    const seek = (seconds) => {
      if (disposed || !Number.isFinite(seconds)) return;
      elapsed = Math.max(0, Math.min(data.duration, seconds));
      if (playing) startedAt = global.performance.now();
      renderAt(elapsed);
    };
    button.addEventListener('click', onClick);
    renderAt(0);
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      playing = false;
      stop();
      button.removeEventListener('click', onClick);
      if (resizeObserver) resizeObserver.disconnect();
      wrapper.remove();
    };
    const api = {
      play, pause, seek, setLoop: (enabled) => { loop.checked = Boolean(enabled); },
      dispose,
      getCurrentTime: () => playing
        ? elapsed + (global.performance.now() - startedAt) / 1000
        : elapsed,
      get element() { return wrapper; },
    };
    if (options.autoplay === true && !(global.matchMedia &&
      global.matchMedia('(prefers-reduced-motion: reduce)').matches)) play();
    return api;
  }
  global.AsciiDeltaBenchmarkPlayer = { mount };
})(typeof window !== 'undefined' ? window : globalThis);`;

export const deltaBenchmarkPlayerJavaScript = deltaBenchmarkPlayer;

export const deltaBenchmarkReadme = [
  'ASCII video row-delta benchmark bundle',
  'Open index.html directly in a desktop browser. It works offline, starts paused, and includes labeled Play/Pause and Loop controls.',
  'Files: index.html is the runnable example; player.js is the reusable benchmark player; data.json contains version 1 metadata and timestamped row changes. This experimental representation is for measurement only and is not the shipped ASCII code output contract.',
  'Separate application setup: copy player.js and data.json into your app, load player.js with a script tag, parse data.json, find a container element, then call AsciiDeltaBenchmarkPlayer.mount({container, data}). The returned instance provides play(), pause(), seek(seconds), setLoop(enabled), getCurrentTime(), element, and dispose(). seek accepts seconds from 0 through the recorded duration. The loop option defaults to true; setLoop controls whether playback wraps at the end.',
  'Sizing: the frame scales down to fit the container width while preserving its aspect ratio and cell proportions. The logical grid does not change when presentation size changes.',
  'Autoplay is off by default. If an integrator passes autoplay: true, the player suppresses unsolicited playback when prefers-reduced-motion is reduce. dispose() stops scheduling, disconnects its resize observer, removes its event listener, and removes the mounted player.',
  'Data compatibility: row-delta frames contain only changed character rows and, in source-color mode, changed color rows. The player reconstructs complete grids while playing and replays row changes when seeking backward. The system monospace font can vary across platforms.',
  'Limits and generation timings in the accompanying benchmark report are measurements, not general guarantees. The actual product bundle remains version 1 with independently seekable full grids.',
].join('\n\n');

// Development-only comparison consumer; version 1 continues to ship full grids.
export function createDeltaBenchmarkHtml(data: DeltaBenchmarkData) {
  const json = safeJson(data);
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ASCII delta benchmark</title>
<style>body{margin:2rem;background:${data.background};color:${data.foreground};font-family:system-ui,sans-serif}button,input{font:inherit}</style>
<div id="ascii-player" aria-label="ASCII video player"></div>
<script type="application/json" id="ascii-data">${json}</script>
<script>${deltaBenchmarkPlayer.replace(/<\/script/gi, '<\\/script')}</script>
<script>AsciiDeltaBenchmarkPlayer.mount({container:document.getElementById('ascii-player'),data:JSON.parse(document.getElementById('ascii-data').textContent)});</script>
`;
}
