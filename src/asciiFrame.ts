import type { CharacterPreset, Treatment } from './treatment';

export type FrameSample = {
  draw(
    context: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    width?: number,
    height?: number,
  ): void;
};

export type SourceGeometry = { width: number; height: number };

export type AsciiFrame = {
  columns: number;
  rows: number;
  logicalWidth: number;
  logicalHeight: number;
  cellWidth: number;
  cellHeight: number;
  characters: string[];
  colors?: string[];
};

const characters =
  ' .\'`^",:;Il!i~+_-?][}{1)(|\\/*tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
const ramps: Record<CharacterPreset, string> = {
  Classic: characters,
  Minimal: ' .#',
  Binary: ' 01',
};

export function createAsciiFrame(
  sample: FrameSample,
  geometry: SourceGeometry,
  treatment: Treatment,
  output: SourceGeometry = geometry,
  samplingCanvas?: OffscreenCanvas,
): AsciiFrame {
  const columns = treatment.density;
  const rows = Math.max(1, Math.round(((columns * geometry.height) / geometry.width) * 0.55));
  const source = samplingCanvas ?? new OffscreenCanvas(columns, rows);
  if (source.width !== columns) source.width = columns;
  if (source.height !== rows) source.height = rows;
  const context = source.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas 2D is unavailable.');
  context.clearRect(0, 0, columns, rows);
  sample.draw(context, 0, 0, columns, rows);
  const pixels = context.getImageData(0, 0, columns, rows).data;
  const ramp = ramps[treatment.preset];
  const selected: string[] = [];
  const colors: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    let colorLine = '';
    for (let x = 0; x < columns; x++) {
      const offset = (y * columns + x) * 4;
      let brightness =
        (pixels[offset]! * 0.2126 +
          pixels[offset + 1]! * 0.7152 +
          pixels[offset + 2]! * 0.0722) /
        255;
      brightness =
        (brightness - 0.5) * (treatment.contrast / 100) +
        0.5 +
        treatment.brightness / 100;
      brightness = Math.max(0, Math.min(1, brightness));
      if (treatment.inverted) brightness = 1 - brightness;
      line +=
        treatment.preset === 'Binary' && brightness < 0.18
          ? ' '
          : ramp[Math.min(ramp.length - 1, Math.floor(brightness * ramp.length))];
      if (treatment.sourceColor) {
        const red = pixels[offset]!.toString(16).padStart(2, '0');
        const green = pixels[offset + 1]!.toString(16).padStart(2, '0');
        const blue = pixels[offset + 2]!.toString(16).padStart(2, '0');
        colorLine += red + green + blue;
      }
    }
    selected.push(line);
    if (treatment.sourceColor) colors.push(colorLine);
  }
  const cellHeight = output.height / rows;
  return {
    columns,
    rows,
    logicalWidth: output.width,
    logicalHeight: output.height,
    cellWidth: output.width / columns,
    cellHeight,
    characters: selected,
    ...(treatment.sourceColor ? { colors } : {}),
  };
}

export function paintAsciiFrame(
  frame: AsciiFrame,
  target: OffscreenCanvas,
  treatment: Treatment,
) {
  const context = target.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable.');
  context.fillStyle = treatment.background;
  context.fillRect(0, 0, target.width, target.height);
  context.font = `${frame.cellHeight}px monospace`;
  context.textBaseline = 'top';
  let currentFillStyle = '';
  for (let y = 0; y < frame.rows; y++) {
    for (let x = 0; x < frame.columns; x++) {
      const color = frame.colors?.[y]?.slice(x * 6, x * 6 + 6);
      const fillStyle = color ? `#${color}` : treatment.foreground;
      if (fillStyle !== currentFillStyle) {
        context.fillStyle = fillStyle;
        currentFillStyle = fillStyle;
      }
      context.fillText(
        frame.characters[y]![x]!,
        x * frame.cellWidth,
        y * frame.cellHeight,
      );
    }
  }
}
