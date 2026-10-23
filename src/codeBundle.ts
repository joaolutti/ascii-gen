export type BundleFile = { name: string; content: string };

const player = `(function (global) {
  'use strict';
  const fail = () => { throw new Error('Unsupported or corrupt ASCII data.'); };
  function validate(data) {
    if (!data || data.version !== 1 ||
      !Number.isInteger(data.width) || data.width < 1 || data.width > 1280 ||
      !Number.isInteger(data.height) || data.height < 1 || data.height > 1280 ||
      !Number.isInteger(data.columns) || data.columns < 24 || data.columns > 160 ||
      (data.columns - 24) % 8 !== 0 ||
      !Number.isInteger(data.rows) || data.rows < 1 || data.rows > 1200 ||
      data.columns * data.rows > 288000 ||
      !Number.isFinite(data.cellWidth) || data.cellWidth <= 0 ||
      !Number.isFinite(data.cellHeight) || data.cellHeight <= 0 ||
      !Number.isFinite(data.fontSize) || data.fontSize <= 0 ||
      Math.abs(data.cellWidth * data.columns - data.width) > 0.01 ||
      Math.abs(data.cellHeight * data.rows - data.height) > 0.01 ||
      Math.abs(data.fontSize - data.cellHeight) > 0.01 ||
      !Number.isFinite(data.duration) || data.duration <= 0 || data.duration >= 15 ||
      !Array.isArray(data.frames) || data.frames.length < 1 || data.frames.length > 450 ||
      data.columns * data.rows * data.frames.length > 7200000) fail();
    let previous = -1;
    for (const frame of data.frames) {
      if (!frame || !Number.isFinite(frame.timestamp) || frame.timestamp < 0 ||
        frame.timestamp <= previous || frame.timestamp >= data.duration ||
        !Number.isFinite(frame.duration) || frame.duration <= 0 ||
        frame.timestamp + frame.duration > data.duration + 0.001 ||
        !Array.isArray(frame.rows) || frame.rows.length !== data.rows ||
        frame.rows.some((row) => typeof row !== 'string' || row.length !== data.columns)) fail();
      previous = frame.timestamp;
      if (frame.colors !== undefined && (!Array.isArray(frame.colors) ||
        frame.colors.length !== data.rows || frame.colors.some((row) =>
          typeof row !== 'string' || row.length !== data.columns * 6 ||
          !/^(?:[a-f0-9]{6})+$/i.test(row)))) fail();
    }
    if (data.frames[0].timestamp !== 0) fail();
    return data;
  }
  function mount(options) {
    if (!options || !options.container || typeof options.container.append !== 'function')
      throw new TypeError('mount requires a container element and ASCII data.');
    const data = validate(options.data);
    const container = options.container;
    const doc = container.ownerDocument;
    const wrapper = doc.createElement('div');
    const output = doc.createElement('pre');
    const controls = doc.createElement('div');
    const button = doc.createElement('button');
    const label = doc.createElement('label');
    const loop = doc.createElement('input');
    wrapper.style.cssText = 'width:100%;';
    output.setAttribute('aria-label', options.label || 'ASCII video frame');
    output.style.cssText = 'box-sizing:border-box;margin:0;overflow:hidden;white-space:pre;aspect-ratio:' + data.width + '/' + data.height + ';font-family:monospace;font-size:' + data.fontSize + 'px;line-height:' + data.cellHeight + 'px;letter-spacing:0;padding:0;';
    controls.style.cssText = 'display:flex;align-items:center;gap:.5rem;margin-top:.5rem;';
    button.type = 'button';
    button.textContent = 'Play';
    loop.type = 'checkbox';
    loop.checked = options.loop !== false;
    loop.setAttribute('aria-label', 'Loop playback');
    label.append(loop, doc.createTextNode(' Loop'));
    controls.append(button, label);
    wrapper.append(output, controls);
    container.append(wrapper);
    let playing = false;
    let disposed = false;
    let elapsed = 0;
    let startedAt = 0;
    let raf = 0;
    let frameIndex = -1;
    let resizeObserver = null;
    const renderAt = (time) => {
      let lo = 0, hi = data.frames.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (data.frames[mid].timestamp <= time) lo = mid + 1;
        else hi = mid;
      }
      const index = Math.max(0, lo - 1);
      if (index === frameIndex) return;
      frameIndex = index;
      const frame = data.frames[index];
      if (!frame.colors) { output.textContent = frame.rows.join('\\n'); return; }
      const fragment = doc.createDocumentFragment();
      for (let y = 0; y < data.rows; y++) {
        for (let x = 0; x < data.columns; x++) {
          const span = doc.createElement('span');
          span.style.color = '#' + frame.colors[y].slice(x * 6, x * 6 + 6);
          span.textContent = frame.rows[y][x];
          fragment.append(span);
        }
        if (y + 1 < data.rows) fragment.append(doc.createTextNode('\\n'));
      }
      output.replaceChildren(fragment);
    };
    const syncSize = () => {
      const available = wrapper.clientWidth;
      const scale = Math.min(1, available / data.width);
      output.style.fontSize = (data.fontSize * scale) + 'px';
      output.style.lineHeight = (data.cellHeight * scale) + 'px';
      output.style.width = (data.width * scale) + 'px';
      output.style.height = (data.height * scale) + 'px';
    };
    if (typeof global.ResizeObserver === 'function') {
      resizeObserver = new global.ResizeObserver(syncSize);
      resizeObserver.observe(container);
    }
    syncSize();
    const stopSchedule = () => { if (raf) global.cancelAnimationFrame(raf); raf = 0; };
    const updateButton = () => { button.textContent = playing ? 'Pause' : 'Play'; };
    const pause = () => {
      if (disposed || !playing) return;
      elapsed = Math.min(data.duration, elapsed + (global.performance.now() - startedAt) / 1000);
      playing = false;
      stopSchedule();
      updateButton();
      renderAt(Math.min(elapsed, data.duration - Number.EPSILON));
    };
    const play = () => {
      if (disposed || playing) return;
      if (elapsed >= data.duration) elapsed = 0;
      playing = true;
      startedAt = global.performance.now();
      updateButton();
      raf = global.requestAnimationFrame(tick);
    };
    const tick = (now) => {
      raf = 0;
      if (!playing || disposed) return;
      const time = elapsed + (now - startedAt) / 1000;
      if (time >= data.duration) {
        if (!loop.checked) {
          elapsed = data.duration;
          playing = false;
          updateButton();
          renderAt(Math.max(0, data.duration - 0.000001));
          return;
        }
        const wrapped = time % data.duration;
        elapsed = wrapped;
        startedAt = now;
        renderAt(wrapped);
      } else renderAt(time);
      raf = global.requestAnimationFrame(tick);
    };
    const onClick = () => playing ? pause() : play();
    button.addEventListener('click', onClick);
    const seek = (time) => {
      if (disposed || !Number.isFinite(time)) return;
      elapsed = Math.max(0, Math.min(data.duration, time));
      if (playing) startedAt = global.performance.now();
      renderAt(Math.min(elapsed, Math.max(0, data.duration - 0.000001)));
      if (elapsed === data.duration && playing && !loop.checked) pause();
    };
    const setLoop = (enabled) => { loop.checked = Boolean(enabled); };
    const dispose = () => {
      if (disposed) return;
      pause();
      disposed = true;
      stopSchedule();
      button.removeEventListener('click', onClick);
      if (resizeObserver) resizeObserver.disconnect();
      wrapper.remove();
    };
    renderAt(0);
    const api = { play, pause, seek, setLoop, dispose, getCurrentTime: () => playing ? elapsed + (global.performance.now() - startedAt) / 1000 : elapsed, get element() { return wrapper; } };
    if (options.autoplay === true && !(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches)) play();
    return api;
  }
  global.AsciiVideoPlayer = { mount };
})(typeof window !== 'undefined' ? window : globalThis);`;

export const playerJavaScript = player;

function safeJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export function createExampleHtml(data: unknown) {
  const style = data as {
    background: string;
    foreground: string;
    fontSize: number;
    cellHeight: number;
  };
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ASCII video</title>
<style>body{margin:2rem;background:${style.background};color:${style.foreground};font-family:system-ui,sans-serif}button,input{font:inherit}</style>
<div id="ascii-player" aria-label="ASCII video player"></div>
<script type="application/json" id="ascii-data">${safeJson(data)}</script>
<script>${player.replace(/<\/script/gi, '<\\/script')}</script>
<script>AsciiVideoPlayer.mount({container:document.getElementById('ascii-player'),data:JSON.parse(document.getElementById('ascii-data').textContent)});</script>
`;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZip(files: BundleFile[]) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const content = encoder.encode(file.content);
    const crc = crc32(content);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, content.length, true);
    localView.setUint32(22, content.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    localParts.push(local, content);

    const central = new Uint8Array(46 + name.length);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, content.length, true);
    view.setUint32(24, content.length, true);
    view.setUint16(28, name.length, true);
    view.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + content.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const parts = [...localParts, ...centralParts, end];
  const archive = new Uint8Array(offset + centralSize + end.length);
  let position = 0;
  for (const part of parts) {
    archive.set(part, position);
    position += part.length;
  }
  return new Blob([archive.buffer], { type: 'application/zip' });
}
