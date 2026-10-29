import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const cases = [
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

export function fixtureFor(fixtures, item) {
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

export async function setDensity(page, value) {
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

export async function processRss(executable) {
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
