import { useEffect, useRef, useState } from 'react';
import styles from './App.module.css';

function formatTime(seconds: number) {
  const wholeSeconds = Math.floor(seconds);
  const centiseconds = Math.floor((seconds - wholeSeconds) * 100);
  return `${wholeSeconds}:${centiseconds.toString().padStart(2, '0')}`;
}

type WorkerReply =
  | {
      type: 'preview';
      bitmap: ImageBitmap;
      name: string;
      sequence: number;
    }
  | { type: 'ready'; width: number; height: number; duration: number }
  | { type: 'progress'; value: number }
  | { type: 'done'; bytes: ArrayBuffer }
  | { type: 'error'; message: string };

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const previewSequenceRef = useRef(0);
  const playbackTimeRef = useRef(0);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('Choose a short H.264 MP4 to begin.');
  const [canExport, setCanExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    return () => {
      workerRef.current?.postMessage({ type: 'dispose' });
      workerRef.current?.terminate();
    };
  }, []);

  useEffect(
    () => () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    },
    [downloadUrl],
  );

  useEffect(() => {
    if (!playing || !duration || exporting) return;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      playbackTimeRef.current =
        (playbackTimeRef.current + (now - previous) / 1000) % duration;
      previous = now;
      setCurrentTime(playbackTimeRef.current);
    }, 100);
    return () => window.clearInterval(timer);
  }, [duration, exporting, playing]);

  useEffect(() => {
    if (!duration || !workerRef.current || exporting) return;
    const sequence = ++previewSequenceRef.current;
    workerRef.current.postMessage({
      type: 'preview',
      timestamp: currentTime,
      sequence,
    });
  }, [currentTime, duration, exporting]);

  const chooseFile = (file?: File) => {
    if (!file) return;
    workerRef.current?.terminate();
    workerRef.current = null;
    previewSequenceRef.current = 0;
    setDownloadUrl((url) => {
      if (url) URL.revokeObjectURL(url);
      return '';
    });
    setName(file.name);
    setCanExport(false);
    setExporting(false);
    setProgress(0);
    setDuration(0);
    setCurrentTime(0);
    playbackTimeRef.current = 0;
    setPlaying(false);
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    if (file.size > 100_000_000) {
      setMessage(
        'This source video is larger than 100 MB (100,000,000 bytes). Choose a smaller file.',
      );
      return;
    }
    setMessage('Reading source video locally…');
    const worker = new Worker(new URL('./video.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (workerRef.current !== worker) {
        if (reply.type === 'preview') reply.bitmap.close();
        return;
      }
      if (reply.type === 'preview') {
        if (reply.sequence !== previewSequenceRef.current) {
          reply.bitmap.close();
          return;
        }
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = reply.bitmap.width;
          canvas.height = reply.bitmap.height;
          canvas.getContext('2d')?.drawImage(reply.bitmap, 0, 0);
          reply.bitmap.close();
        }
        setName(reply.name);
      } else if (reply.type === 'ready') {
        setDuration(reply.duration);
        playbackTimeRef.current = 0;
        setMessage('Checking H.264 MP4 export on this device…');
        void (async () => {
          const supported =
            typeof VideoEncoder !== 'undefined' &&
            (
              await VideoEncoder.isConfigSupported({
                codec: 'avc1.42001f',
                width: reply.width,
                height: reply.height,
                bitrate: 1_500_000,
                framerate: 30,
              })
            ).supported === true;
          if (workerRef.current !== worker) return;
          setCanExport(supported);
          setMessage(
            supported
              ? 'Classic characters · white on near-black'
              : 'This browser cannot encode H.264 MP4 on this device.',
          );
        })().catch(() => {
          if (workerRef.current !== worker) return;
          setCanExport(false);
          setMessage('This browser cannot encode H.264 MP4 on this device.');
        });
      } else if (reply.type === 'progress') {
        setProgress(reply.value);
      } else if (reply.type === 'done') {
        const url = URL.createObjectURL(
          new Blob([reply.bytes], { type: 'video/mp4' }),
        );
        setDownloadUrl(url);
        setExporting(false);
        setMessage('Your silent ASCII video is ready.');
      } else if (reply.type === 'error') {
        setExporting(false);
        setMessage(reply.message);
      }
    };
    worker.postMessage({ type: 'load', file });
  };

  const exportVideo = () => {
    setPlaying(false);
    setExporting(true);
    setProgress(0);
    setMessage('Encoding on this device…');
    workerRef.current?.postMessage({ type: 'export' });
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brand}>ASCII VIDEO</span>
        <span className={styles.local}>Processed on this device</span>
      </header>
      <section
        className={styles.workspace}
        aria-label="Video converter"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          chooseFile(event.dataTransfer.files[0]);
        }}
      >
        <div className={styles.previewColumn}>
          <div className={styles.preview}>
            {name ? (
              <canvas ref={canvasRef} aria-label="ASCII preview" />
            ) : (
              <div className={styles.empty}>
                <span className={styles.mark}>A·S·C·I·I</span>
                <span>Preview will appear here</span>
              </div>
            )}
          </div>
          {name && duration > 0 && (
            <div className={styles.playback} aria-label="Preview playback">
              <button
                type="button"
                className={styles.playButton}
                disabled={exporting}
                aria-label={playing ? 'Pause preview' : 'Play preview'}
                onClick={() => setPlaying((value) => !value)}
              >
                {playing ? 'Pause' : 'Play'}
              </button>
              <input
                className={styles.seek}
                type="range"
                aria-label="Preview position"
                min={0}
                max={duration}
                step={0.01}
                value={currentTime}
                disabled={exporting}
                onChange={(event) => {
                  const time = Number(event.currentTarget.value);
                  playbackTimeRef.current = time;
                  setCurrentTime(time);
                }}
              />
              <span className={styles.playbackTime}>
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
          )}
        </div>
        <aside className={styles.panel}>
          <p className={styles.eyebrow}>SOURCE VIDEO</p>
          <label className={styles.picker}>
            <span>{name ? 'Replace video' : 'Choose a video'}</span>
            <input
              aria-label="Choose source video"
              type="file"
              accept="video/mp4,.mp4"
              onChange={(event) => {
                chooseFile(event.target.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
          </label>
          {name && <h1 className={styles.filename}>{name}</h1>}
          <p role="status" className={styles.status}>
            {message}
          </p>
          <div className={styles.divider} />
          <p className={styles.eyebrow}>CHARACTER PRESET</p>
          <div className={styles.preset}>
            Classic <span>default</span>
          </div>
          <p className={styles.eyebrow}>COLORS</p>
          <div className={styles.colors}>
            <span>
              <i /> Foreground
            </span>
            <span>
              <i className={styles.backgroundSwatch} /> Background
            </span>
          </div>
          <button
            className={styles.export}
            disabled={!canExport || exporting}
            onClick={exportVideo}
          >
            {exporting
              ? `Exporting ${Math.round(progress * 100)}%`
              : 'Export MP4'}
          </button>
          {downloadUrl && (
            <a
              className={styles.download}
              href={downloadUrl}
              download="ascii-video.mp4"
            >
              Download silent MP4
            </a>
          )}
          <p className={styles.note}>
            MP4 export needs a browser with H.264 encoding support.
          </p>
        </aside>
      </section>
    </main>
  );
}
