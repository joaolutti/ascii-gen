import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

mkdirSync('public/fixtures', { recursive: true });
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=320x180:rate=12:duration=2',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=2',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-preset',
  'ultrafast',
  '-crf',
  '28',
  '-c:a',
  'aac',
  '-shortest',
  'public/fixtures/landscape.mp4',
]);
console.log('Created public/fixtures/landscape.mp4');
