import { useEffect, useRef, useState } from 'react';
import styles from './App.module.css';

type WorkerReply =
  | { type: 'preview'; bitmap: ImageBitmap; name: string }
  | { type: 'ready'; supported: boolean; message: string }
  | { type: 'progress'; value: number }
  | { type: 'done'; bytes: ArrayBuffer }
  | { type: 'error'; message: string };

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('Choose a short H.264 MP4 to begin.');
  const [canExport, setCanExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState('');

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    },
    [downloadUrl],
  );

  const chooseFile = (file?: File) => {
    if (!file) return;
    workerRef.current?.terminate();
    setDownloadUrl((url) => {
      if (url) URL.revokeObjectURL(url);
      return '';
    });
    setName(file.name);
    setCanExport(false);
    setMessage('Reading source video locally…');
    const worker = new Worker(new URL('./video.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'preview') {
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = reply.bitmap.width;
          canvas.height = reply.bitmap.height;
          canvas.getContext('2d')?.drawImage(reply.bitmap, 0, 0);
          reply.bitmap.close();
        }
        setName(reply.name);
      } else if (reply.type === 'ready') {
        setCanExport(reply.supported);
        setMessage(reply.message);
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
      <section className={styles.workspace} aria-label="Video converter">
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
        <aside className={styles.panel}>
          <p className={styles.eyebrow}>SOURCE VIDEO</p>
          <label className={styles.picker}>
            <span>{name ? 'Replace video' : 'Choose a video'}</span>
            <input
              aria-label="Choose source video"
              type="file"
              accept="video/mp4,.mp4"
              onChange={(event) => chooseFile(event.target.files?.[0])}
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
