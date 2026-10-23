export type BundleFile = { name: string; content: string };

const player = `(() => {
  const payload = document.getElementById('ascii-data');
  const source = payload && payload.textContent;
  if (!source || source.length > 5000000)
    throw new Error('Invalid or oversized ASCII data.');
  const data = JSON.parse(source);
  const fail = () => { throw new Error('Unsupported or corrupt ASCII data.'); };
  if (
    !data || data.version !== 1 ||
    !Number.isInteger(data.width) || data.width < 1 || data.width > 1280 ||
    !Number.isInteger(data.height) || data.height < 1 || data.height > 1280 ||
    !Number.isInteger(data.columns) || data.columns < 1 || data.columns > 160 ||
    !Number.isInteger(data.rows) || data.rows < 1 || data.rows > 1200 ||
    data.columns * data.rows > 288000 ||
    !Number.isFinite(data.cellWidth) || data.cellWidth <= 0 ||
    !Number.isFinite(data.cellHeight) || data.cellHeight <= 0 ||
    !Number.isFinite(data.fontSize) || data.fontSize <= 0 ||
    !Number.isFinite(data.duration) || data.duration <= 0 || data.duration >= 15 ||
    !Array.isArray(data.frames) || data.frames.length < 1 || data.frames.length > 450 ||
    data.columns * data.rows * data.frames.length > 7200000
  ) fail();
  let previousTimestamp = -1;
  for (const frame of data.frames) {
    if (
      !Number.isFinite(frame.timestamp) || frame.timestamp < 0 ||
      frame.timestamp <= previousTimestamp || frame.timestamp >= data.duration ||
      !Number.isFinite(frame.duration) || frame.duration <= 0 ||
      !Array.isArray(frame.rows) || frame.rows.length !== data.rows ||
      frame.rows.some((row) => typeof row !== 'string' || row.length !== data.columns)
    ) fail();
    previousTimestamp = frame.timestamp;
    if (frame.colors !== undefined && (
      !Array.isArray(frame.colors) || frame.colors.length !== data.rows ||
      frame.colors.some((row) => typeof row !== 'string' ||
        row.length !== data.columns * 6 || !/^(?:[a-f0-9]{6})+$/i.test(row))
    )) fail();
  }
  const output = document.querySelector('pre');
  const button = document.querySelector('button');
  const loop = document.querySelector('input[type=checkbox]');
  let playing = false;
  let start = 0;
  let offset = 0;
  let frameIndex = 0;
  const show = (index) => {
    frameIndex = index;
    const frame = data.frames[index];
    if (!frame.colors) {
      output.textContent = frame.rows.join('\\n');
      return;
    }
    const fragment = document.createDocumentFragment();
    for (let y = 0; y < data.rows; y++) {
      for (let x = 0; x < data.columns; x++) {
        const character = document.createElement('span');
        character.style.color = '#' + frame.colors[y].slice(x * 6, x * 6 + 6);
        character.textContent = frame.rows[y][x];
        fragment.append(character);
      }
      if (y + 1 < data.rows) fragment.append(document.createTextNode('\\n'));
    }
    output.replaceChildren(fragment);
  };
  const tick = (now) => {
    if (!playing) return;
    if (!start) start = now - offset * 1000;
    const elapsed = (now - start) / 1000;
    if (elapsed >= data.duration) {
      if (!loop.checked) {
        playing = false;
        button.textContent = 'Play';
        offset = data.duration;
        return;
      }
      start = now;
      offset = 0;
      frameIndex = 0;
    }
    const time = (now - start) / 1000;
    while (
      frameIndex + 1 < data.frames.length &&
      data.frames[frameIndex + 1].timestamp <= time
    )
      frameIndex++;
    show(frameIndex);
    requestAnimationFrame(tick);
  };
  button.addEventListener('click', () => {
    playing = !playing;
    button.textContent = playing ? 'Pause' : 'Play';
    if (playing) {
      start = performance.now() - offset * 1000;
      requestAnimationFrame(tick);
    } else {
      offset = Math.min(data.duration, (performance.now() - start) / 1000);
    }
  });
  show(0);
})();`;

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
<style>body{margin:2rem;background:${style.background};color:${style.foreground};font-family:system-ui,sans-serif}pre{font-family:monospace;font-size:${style.fontSize}px;line-height:${style.cellHeight}px;white-space:pre;overflow:auto}button,input{font:inherit}</style>
<pre aria-label="ASCII video frame"></pre>
<button type="button">Play</button> <label><input type="checkbox" checked> Loop</label>
<script type="application/json" id="ascii-data">${safeJson(data)}</script>
<script>${player.replace(/<\/script/gi, '<\\/script')}</script>
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
