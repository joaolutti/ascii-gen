import { useEffect, useRef, useState } from 'react';
import styles from './App.module.css';
import type { CharacterPreset, RenderMode, Treatment } from './treatment';

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
  | {
      type: 'progress';
      operationId: number;
      value: number;
      completedFrames: number;
      totalFrames: number;
    }
  | { type: 'done'; operationId: number; bytes: ArrayBuffer }
  | {
      type: 'code-bundle-progress';
      operationId: number;
      value: number;
      completedFrames: number;
      totalFrames: number;
    }
  | { type: 'code-bundle-done'; operationId: number; bytes: ArrayBuffer }
  | { type: 'code-bundle-canceled'; operationId: number }
  | { type: 'canceled'; operationId: number }
  | { type: 'disposed' }
  | { type: 'error'; message: string; operationId?: number };

const defaultTreatment: Treatment = {
  mode: 'ASCII',
  density: 88,
  gridStep: 8,
  spacing: 25,
  brightness: 0,
  contrast: 100,
  inverted: false,
  preset: 'Classic',
  foreground: '#ffffff',
  background: '#111111',
  sourceColor: false,
};

const defaultPixelatedTreatment: Treatment = {
  ...defaultTreatment,
  mode: 'Pixelated',
  foreground: '#ffb547',
  background: '#000000',
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const pendingWorkerRef = useRef<Worker | null>(null);
  const previewSequenceRef = useRef(0);
  const playbackTimeRef = useRef(0);
  const codeBundleOperationIdRef = useRef(0);
  const activeCodeBundleRef = useRef<number | undefined>(undefined);
  const exportOperationIdRef = useRef(0);
  const activeExportRef = useRef<number | undefined>(undefined);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('Choose a short H.264 MP4 to begin.');
  const [canExport, setCanExport] = useState(false);
  const [canGenerateBundle, setCanGenerateBundle] = useState(false);
  const [generatingBundle, setGeneratingBundle] = useState(false);
  const [checkingReplacement, setCheckingReplacement] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [bundleUrl, setBundleUrl] = useState('');
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<RenderMode>('ASCII');
  const [treatments, setTreatments] = useState<Record<RenderMode, Treatment>>({
    ASCII: defaultTreatment,
    Pixelated: defaultPixelatedTreatment,
  });
  const treatment = treatments[mode];
  const treatmentRef = useRef(treatment);
  treatmentRef.current = treatment;
  const setTreatment = (update: (current: Treatment) => Treatment) =>
    setTreatments((current) => ({
      ...current,
      [mode]: update(current[mode]),
    }));

  useEffect(() => {
    return () => {
      releaseWorker(workerRef.current);
      releaseWorker(pendingWorkerRef.current);
    };
  }, []);

  useEffect(() => {
    setDownloadUrl((url) => {
      if (url) URL.revokeObjectURL(url);
      return '';
    });
    setBundleUrl('');
  }, [treatment]);

  useEffect(
    () => () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    },
    [downloadUrl],
  );

  useEffect(() => {
    if (!bundleUrl) return;
    return () => URL.revokeObjectURL(bundleUrl);
  }, [bundleUrl]);

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
      treatment,
    });
  }, [currentTime, duration, exporting, treatment]);

  const chooseFile = (file?: File) => {
    if (!file || exporting || generatingBundle) return;
    if (file.size > 100_000_000) {
      setMessage(
        'This source video is larger than 100 MB (100,000,000 bytes). Choose a smaller file.',
      );
      return;
    }
    if (pendingWorkerRef.current) releaseWorker(pendingWorkerRef.current);
    setCheckingReplacement(true);
    setMessage('Checking replacement video locally…');
    const worker = new Worker(new URL('./video.worker.ts', import.meta.url), {
      type: 'module',
    });
    pendingWorkerRef.current = worker;
    let initialPreview: ImageBitmap | undefined;
    let ready = false;
    const reject = (reason: string) => {
      if (pendingWorkerRef.current !== worker) return;
      pendingWorkerRef.current = null;
      setCheckingReplacement(false);
      initialPreview?.close();
      releaseWorker(worker);
      setMessage(reason);
    };
    worker.onerror = () =>
      reject('This file could not be read as a supported video. Choose an H.264 MP4.');
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (pendingWorkerRef.current !== worker) {
        if (reply.type === 'preview') reply.bitmap.close();
        return;
      }
      if (reply.type === 'preview') {
        initialPreview?.close();
        initialPreview = reply.bitmap;
        return;
      }
      if (reply.type === 'error') {
        reject(reply.message);
        return;
      }
      if (reply.type !== 'ready' || ready || !initialPreview) return;
      ready = true;
      const previous = workerRef.current;
      workerRef.current = worker;
      pendingWorkerRef.current = null;
      setCheckingReplacement(false);
      if (previous) releaseWorker(previous);
      previewSequenceRef.current = 0;
      activeCodeBundleRef.current = undefined;
      codeBundleOperationIdRef.current++;
      setDownloadUrl((url) => {
        if (url) URL.revokeObjectURL(url);
        return '';
      });
      setBundleUrl('');
      setName(file.name);
      setCanExport(false);
      setCanGenerateBundle(typeof CompressionStream === 'function');
      setGeneratingBundle(false);
      setDuration(reply.duration);
      setCurrentTime(0);
      playbackTimeRef.current = 0;
      setPlaying(false);
      setProgress(0);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = initialPreview.width;
        canvas.height = initialPreview.height;
        canvas.getContext('2d')?.drawImage(initialPreview, 0, 0);
      }
      initialPreview.close();
      initialPreview = undefined;
      worker.onmessage = (activeEvent) => {
        const activeReply = activeEvent.data;
        if (activeReply.type === 'preview') {
          if (activeReply.sequence !== previewSequenceRef.current) {
            activeReply.bitmap.close();
            return;
          }
          const activeCanvas = canvasRef.current;
          if (activeCanvas) {
            activeCanvas.width = activeReply.bitmap.width;
            activeCanvas.height = activeReply.bitmap.height;
            activeCanvas.getContext('2d')?.drawImage(activeReply.bitmap, 0, 0);
            activeReply.bitmap.close();
          }
        } else if (activeReply.type === 'ready') {
          // The active worker already sent its readiness reply at commit time.
        } else if (activeReply.type === 'disposed') {
          worker.terminate();
        } else {
          handleActiveReply(activeReply);
        }
      };
      previewSequenceRef.current = 1;
      worker.postMessage({
        type: 'preview',
        timestamp: 0,
        sequence: previewSequenceRef.current,
        treatment: treatmentRef.current,
      });
      setMessage('Source video ready. Checking MP4 encoding support…');
        void (async () => {
          let supported = false;
          try {
            supported = typeof VideoEncoder !== 'undefined' &&
              (await VideoEncoder.isConfigSupported({
                codec: 'avc1.42001f', width: reply.width, height: reply.height,
                bitrate: 1_500_000, framerate: 30,
              })).supported === true;
          } catch {
            supported = false;
          }
          if (workerRef.current !== worker) return;
          setCanExport(supported);
          if (!supported) setMessage('Source video ready. This browser cannot encode H.264 MP4 on this device.');
          else setMessage('Source video ready.');
        })();
    };
    const testOptions = new URLSearchParams(window.location.search);
    worker.postMessage({
      type: 'load',
      file,
      testExportFailure:
        import.meta.env.DEV && testOptions.has('testExportFailure'),
      testExportDelay: import.meta.env.DEV
        ? Number(testOptions.get('testExportDelay') ?? 0)
        : 0,
      testCodeBundleFailure:
        import.meta.env.DEV && testOptions.has('testCodeBundleFailure'),
      testCodeBundleDelay: import.meta.env.DEV
        ? Number(testOptions.get('testCodeBundleDelay') ?? 0)
        : 0,
      testCodeBundleLimitAfterFrames: import.meta.env.DEV
        ? Number(testOptions.get('testCodeBundleLimitAfterFrames') ?? 0)
        : 0,
    });
  };

  const handleActiveReply = (reply: WorkerReply) => {
      if (reply.type === 'progress') {
        if (reply.operationId !== activeExportRef.current) return;
        setProgress(reply.value);
      } else if (reply.type === 'done') {
        if (reply.operationId !== activeExportRef.current) return;
        activeExportRef.current = undefined;
        const url = URL.createObjectURL(
          new Blob([reply.bytes], { type: 'video/mp4' }),
        );
        setDownloadUrl(url);
        setExporting(false);
        setMessage('Your silent MP4 download was requested.');
        requestDownload(url, 'ascii-video.mp4');
      } else if (reply.type === 'code-bundle-progress') {
        if (activeCodeBundleRef.current !== reply.operationId) return;
        setProgress(reply.value);
      } else if (reply.type === 'code-bundle-done') {
        if (activeCodeBundleRef.current !== reply.operationId) return;
        activeCodeBundleRef.current = undefined;
        setGeneratingBundle(false);
        setProgress(1);
        const url = URL.createObjectURL(
          new Blob([reply.bytes], { type: 'application/zip' }),
        );
        setBundleUrl(url);
        setMessage('Your ASCII code bundle is ready. Download requested.');
        requestDownload(url, 'ascii-code-bundle.zip');
      } else if (reply.type === 'code-bundle-canceled') {
        if (activeCodeBundleRef.current !== reply.operationId) return;
        activeCodeBundleRef.current = undefined;
        setGeneratingBundle(false);
        setProgress(0);
        setMessage(
          'Generation canceled. Your source video and settings are ready to try again.',
        );
      } else if (reply.type === 'canceled') {
        if (reply.operationId !== activeExportRef.current) return;
        activeExportRef.current = undefined;
        setExporting(false);
        setProgress(0);
        setMessage(
          'Export canceled. Your source video and settings are ready.',
        );
      } else if (reply.type === 'error') {
        if (
          reply.operationId !== undefined &&
          reply.operationId !== activeExportRef.current &&
          reply.operationId !== activeCodeBundleRef.current
        ) return;
        const failedBundle =
          reply.operationId !== undefined &&
          activeCodeBundleRef.current === reply.operationId;
        if (failedBundle) activeCodeBundleRef.current = undefined;
        else if (reply.operationId === activeExportRef.current)
          activeExportRef.current = undefined;
        setGeneratingBundle(false);
        setExporting(false);
        setProgress(0);
        setMessage(
          failedBundle
            ? `Code generation failed: ${reply.message} You can try again.`
            : `Export failed: ${reply.message} You can try again.`,
        );
      }
  };

  const exportVideo = () => {
    if (!canExport || exporting || generatingBundle || !workerRef.current) return;
    setDownloadUrl((url) => {
      if (url) URL.revokeObjectURL(url);
      return '';
    });
    setPlaying(false);
    const operationId = ++exportOperationIdRef.current;
    activeExportRef.current = operationId;
    setExporting(true);
    setProgress(0);
    setMessage('Encoding on this device…');
    workerRef.current.postMessage({ type: 'export', treatment: { ...treatment }, operationId });
  };

  const generateCodeBundle = () => {
    setPlaying(false);
    const operationId = ++codeBundleOperationIdRef.current;
    activeCodeBundleRef.current = operationId;
    setGeneratingBundle(true);
    setProgress(0);
    setMessage('Generating character data locally…');
    workerRef.current?.postMessage({
      type: 'code-bundle',
      operationId,
      treatment: { ...treatment },
    });
  };

  const cancelExport = () => {
    const operationId = activeExportRef.current;
    if (operationId === undefined) return;
    workerRef.current?.postMessage({ type: 'cancel-export', operationId });
  };

  const cancelCodeBundle = () => {
    const operationId = activeCodeBundleRef.current;
    if (operationId === undefined) return;
    workerRef.current?.postMessage({ type: 'cancel-code-bundle', operationId });
  };

  const resetControls = () =>
    setTreatment(() =>
      mode === 'ASCII' ? defaultTreatment : defaultPixelatedTreatment,
    );
  const controlsDisabled = exporting || generatingBundle || checkingReplacement;

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
          if (!controlsDisabled) chooseFile(event.dataTransfer.files[0]);
        }}
      >
        <div className={styles.previewColumn}>
          <div className={styles.preview}>
            {name ? (
              <canvas
                ref={canvasRef}
                aria-label={mode === 'ASCII' ? 'ASCII preview' : 'Pixelated preview'}
              />
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
                disabled={controlsDisabled}
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
                disabled={controlsDisabled}
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
              disabled={controlsDisabled}
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
          <p className={styles.eyebrow}>RENDER MODE</p>
          <label className={styles.controlLabel} htmlFor="render-mode">
            Render mode
          </label>
          <select
            id="render-mode"
            aria-label="Render mode"
            className={styles.select}
            value={mode}
            disabled={controlsDisabled}
            onChange={(event) => {
              setMode(event.currentTarget.value as RenderMode);
            }}
          >
            <option value="ASCII">ASCII</option>
            <option value="Pixelated">Pixelated</option>
          </select>
          {mode === 'ASCII' ? (
            <>
          <p className={styles.eyebrow}>CHARACTER PRESET</p>
          <label className={styles.controlLabel} htmlFor="character-preset">
            Character preset
          </label>
          <select
            id="character-preset"
            aria-label="Character preset"
            className={styles.select}
            value={treatment.preset}
            disabled={controlsDisabled}
            onChange={(event) => {
              const preset = event.currentTarget.value as CharacterPreset;
              setTreatment((current) => ({
                ...current,
                preset,
              }));
            }}
          >
            <option value="Classic">Classic</option>
            <option value="Minimal">Minimal</option>
            <option value="Binary">Binary</option>
          </select>
          <p className={styles.note}>
            Classic: varied ASCII ramp (space to $) · Minimal: space, dot, hash
            · Binary: space, 0, 1
          </p>
          <label className={styles.rangeLabel} htmlFor="density">
            Density <span>{treatment.density} columns</span>
          </label>
          <input
            id="density"
            aria-label="Density"
            className={styles.range}
            type="range"
            min={24}
            max={160}
            step={8}
            value={treatment.density}
            disabled={controlsDisabled}
            onChange={(event) => {
              const density = Number(event.currentTarget.value);
              setTreatment((current) => ({
                ...current,
                density,
              }));
            }}
          />
          <p className={styles.note}>24–160 columns · default 88</p>
          <label className={styles.rangeLabel} htmlFor="brightness">
            Brightness <span>{treatment.brightness}</span>
          </label>
          <input
            id="brightness"
            aria-label="Brightness"
            className={styles.range}
            type="range"
            min={-100}
            max={100}
            step={1}
            value={treatment.brightness}
            disabled={controlsDisabled}
            onChange={(event) => {
              const brightness = Number(event.currentTarget.value);
              setTreatment((current) => ({
                ...current,
                brightness,
              }));
            }}
          />
          <p className={styles.note}>−100 to +100 · default 0</p>
          <label className={styles.rangeLabel} htmlFor="contrast">
            Contrast <span>{treatment.contrast}%</span>
          </label>
          <input
            id="contrast"
            aria-label="Contrast"
            className={styles.range}
            type="range"
            min={0}
            max={200}
            step={1}
            value={treatment.contrast}
            disabled={controlsDisabled}
            onChange={(event) => {
              const contrast = Number(event.currentTarget.value);
              setTreatment((current) => ({
                ...current,
                contrast,
              }));
            }}
          />
          <p className={styles.note}>0–200% · default 100%</p>
          <label className={styles.checkboxLabel}>
            <input
              aria-label="Invert brightness mapping"
              type="checkbox"
              checked={treatment.inverted}
              disabled={controlsDisabled}
              onChange={(event) => {
                const inverted = event.currentTarget.checked;
                setTreatment((current) => ({
                  ...current,
                  inverted,
                }));
              }}
            />
            Invert brightness mapping
          </label>
          <p className={styles.note}>
            Inversion changes character mapping only; colors stay the same.
          </p>
          <p className={styles.eyebrow}>COLORS</p>
          <label className={styles.colorLabel} htmlFor="foreground-color">
            Foreground color
            <input
              id="foreground-color"
              aria-label="Foreground color"
              type="color"
              value={treatment.foreground}
              disabled={controlsDisabled}
              onChange={(event) => {
                const foreground = event.currentTarget.value;
                setTreatment((current) => ({ ...current, foreground }));
              }}
            />
          </label>
          <label className={styles.colorLabel} htmlFor="background-color">
            Background color
            <input
              id="background-color"
              aria-label="Background color"
              type="color"
              value={treatment.background}
              disabled={controlsDisabled}
              onChange={(event) => {
                const background = event.currentTarget.value;
                setTreatment((current) => ({ ...current, background }));
              }}
            />
          </label>
          <label className={styles.checkboxLabel}>
            <input
              aria-label="Source-color mode"
              type="checkbox"
              checked={treatment.sourceColor}
              disabled={controlsDisabled}
              onChange={(event) => {
                const sourceColor = event.currentTarget.checked;
                setTreatment((current) => ({ ...current, sourceColor }));
              }}
            />
            Source-color mode
          </label>
          <p className={styles.note}>
            Source-color mode colors each character from its source region.
            Brightness still selects the character.
          </p>
            </>
          ) : (
            <>
              <label className={styles.rangeLabel} htmlFor="grid-step">
                Grid step <span>{treatment.gridStep} px</span>
              </label>
              <input
                id="grid-step"
                aria-label="Grid step"
                className={styles.range}
                type="range"
                min={4}
                max={40}
                step={4}
                value={treatment.gridStep}
                disabled={controlsDisabled}
                onChange={(event) => {
                  const gridStep = Number(event.currentTarget.value);
                  setTreatment((current) => ({ ...current, gridStep }));
                }}
              />
              <p className={styles.note}>4–40 output pixels · default 8</p>
              <label className={styles.rangeLabel} htmlFor="spacing">
                Cell spacing <span>{treatment.spacing}%</span>
              </label>
              <input
                id="spacing"
                aria-label="Cell spacing"
                className={styles.range}
                type="range"
                min={0}
                max={80}
                step={5}
                value={treatment.spacing}
                disabled={controlsDisabled}
                onChange={(event) => {
                  const spacing = Number(event.currentTarget.value);
                  setTreatment((current) => ({ ...current, spacing }));
                }}
              />
              <p className={styles.note}>0–80% cell spacing · default 25%</p>
              <label className={styles.rangeLabel} htmlFor="brightness">
                Brightness <span>{treatment.brightness}</span>
              </label>
              <input id="brightness" aria-label="Brightness" className={styles.range} type="range" min={-100} max={100} step={1} value={treatment.brightness} disabled={controlsDisabled} onChange={(event) => { const brightness = Number(event.currentTarget.value); setTreatment((current) => ({ ...current, brightness })); }} />
              <label className={styles.rangeLabel} htmlFor="contrast">
                Contrast <span>{treatment.contrast}%</span>
              </label>
              <input id="contrast" aria-label="Contrast" className={styles.range} type="range" min={0} max={200} step={1} value={treatment.contrast} disabled={controlsDisabled} onChange={(event) => { const contrast = Number(event.currentTarget.value); setTreatment((current) => ({ ...current, contrast })); }} />
              <label className={styles.checkboxLabel}>
                <input aria-label="Invert brightness mapping" type="checkbox" checked={treatment.inverted} disabled={controlsDisabled} onChange={(event) => { const inverted = event.currentTarget.checked; setTreatment((current) => ({ ...current, inverted })); }} />
                Invert brightness mapping
              </label>
              <p className={styles.eyebrow}>COLORS</p>
              <label className={styles.colorLabel} htmlFor="foreground-color">
                Foreground color
                <input id="foreground-color" aria-label="Foreground color" type="color" value={treatment.foreground} disabled={controlsDisabled} onChange={(event) => { const foreground = event.currentTarget.value; setTreatment((current) => ({ ...current, foreground })); }} />
              </label>
              <label className={styles.colorLabel} htmlFor="background-color">
                Background color
                <input id="background-color" aria-label="Background color" type="color" value={treatment.background} disabled={controlsDisabled} onChange={(event) => { const background = event.currentTarget.value; setTreatment((current) => ({ ...current, background })); }} />
              </label>
              <p className={styles.note}>Brightness determines the size of each square cell.</p>
            </>
          )}
          <button
            type="button"
            className={styles.reset}
            disabled={controlsDisabled}
            onClick={resetControls}
          >
            Reset controls
          </button>
          <button
            className={styles.export}
            disabled={!canExport || controlsDisabled}
            onClick={exportVideo}
          >
            Generate & download MP4
          </button>
          <button
            type="button"
            className={styles.export}
            disabled={!canGenerateBundle || controlsDisabled || mode !== 'ASCII'}
            onClick={generateCodeBundle}
          >
            Generate ASCII code bundle
          </button>
          {exporting && (
            <div className={styles.exportStatus}>
              <progress aria-label="Export progress" max={1} value={progress} />
              <span>Exporting {Math.round(progress * 100)}% complete</span>
              <button
                type="button"
                className={styles.cancel}
                onClick={cancelExport}
              >
                Cancel export
              </button>
            </div>
          )}
          {generatingBundle && (
            <div className={styles.exportStatus}>
              <progress
                aria-label="Generation progress"
                max={1}
                value={progress}
              />
              <span>Generating {Math.round(progress * 100)}% complete</span>
              <button
                type="button"
                className={styles.cancel}
                onClick={cancelCodeBundle}
              >
                Cancel generation
              </button>
            </div>
          )}
          {downloadUrl && (
            <a
              className={styles.download}
              href={downloadUrl}
              download="ascii-video.mp4"
            >
              Save MP4 again
            </a>
          )}
          {bundleUrl && (
            <a
              className={styles.download}
              href={bundleUrl}
              download="ascii-code-bundle.zip"
            >
              Save ASCII code bundle again
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

function releaseWorker(worker: Worker | null) {
  if (!worker) return;
  const timeout = window.setTimeout(() => worker.terminate(), 1_000);
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    if (event.data.type === 'preview') event.data.bitmap.close();
    if (event.data.type === 'disposed') {
      window.clearTimeout(timeout);
      worker.terminate();
    }
  };
  worker.postMessage({ type: 'dispose' });
}

function requestDownload(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
}
