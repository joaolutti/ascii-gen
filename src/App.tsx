import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import styles from './App.module.css';
import type { CharacterPreset, RenderMode, Treatment } from './treatment';
import {
  generationWorkflowReducer,
  initialGenerationWorkflow,
  type OutputCapabilities,
  type PlaybackWorkflow,
  type SourceCandidate,
  type SourceSession,
} from './editorWorkflow';

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
      generationId: number;
      diagnostics?: WorkerPreviewDiagnostics;
    }
  | {
      type: 'ready';
      width: number;
      height: number;
      duration: number;
      frameRate: number;
    }
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
  | {
      type: 'error';
      message: string;
      operationId?: number;
      generationId?: number;
    };

type WorkerPreviewDiagnostics = {
  sampleLookupDecodeMs: number;
  drawFrameMs: number;
  bitmapCreationMs: number;
  workerTotalMs: number;
  replacedPendingPreviewCount: number;
};

type PreviewDiagnosticState = {
  sourceFrameRate?: number;
  playbackScheduler?: {
    frameIntervalMs: number;
    ticks: number;
    eligible: number;
    published: number;
  };
  requests: {
    sequence: number;
    generationId: number;
    timestamp: number;
    sentAt: number;
  }[];
  replies: {
    sequence: number;
    generationId: number;
    receivedAt: number;
    diagnostics?: WorkerPreviewDiagnostics;
  }[];
  presentations: {
    sequence: number;
    generationId: number;
    requestToPresentationMs: number | null;
    replyToPresentationMs: number | null;
    drawImageMs: number;
  }[];
  droppedReplies: { sequence: number; generationId: number; reason: string }[];
};

function readPreviewDiagnosticState() {
  return (
    window as Window & { __asciiPreviewDiagnostics?: PreviewDiagnosticState }
  ).__asciiPreviewDiagnostics;
}

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
  const previewDiagnosticsEnabled =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).has('previewDiagnostics');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const pendingWorkerRef = useRef<Worker | null>(null);
  const previewSequenceRef = useRef(0);
  const previewGenerationRef = useRef(0);
  const displayedPreviewSequenceRef = useRef(-1);
  const sourceFrameRateRef = useRef(30);
  const playbackTimeRef = useRef(0);
  const codeBundleOperationIdRef = useRef(0);
  const activeCodeBundleRef = useRef<number | undefined>(undefined);
  const exportOperationIdRef = useRef(0);
  const activeExportRef = useRef<number | undefined>(undefined);
  const [source, setSource] = useState<SourceSession>({ tag: 'empty' });
  const [candidate, setCandidate] = useState<SourceCandidate>({ tag: 'idle' });
  const [capabilities, setCapabilities] = useState<OutputCapabilities>({
    mp4: 'unavailable',
    asciiCode: 'unavailable',
  });
  const name = source.tag === 'usable' ? source.name : '';
  const duration = source.tag === 'usable' ? source.duration : 0;
  const [message, setMessage] = useState('Choose a short H.264 MP4 to begin.');
  const [generation, dispatchGeneration] = useReducer(
    generationWorkflowReducer,
    initialGenerationWorkflow,
  );
  const checkingReplacement = candidate.tag === 'checking';
  const exporting =
    (generation.tag === 'running' || generation.tag === 'canceling') &&
    generation.output === 'mp4';
  const generatingBundle =
    (generation.tag === 'running' || generation.tag === 'canceling') &&
    generation.output === 'ascii-code';
  const progress =
    generation.tag === 'running' || generation.tag === 'canceling'
      ? generation.progress
      : generation.tag === 'completed'
        ? 1
        : 0;
  const canExport = capabilities.mp4 === 'available';
  const canGenerateBundle = capabilities.asciiCode === 'available';
  const generationRef = useRef(generation);
  generationRef.current = generation;
  const [downloadUrl, setDownloadUrl] = useState('');
  const [bundleUrl, setBundleUrl] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [playback, setPlayback] = useState<PlaybackWorkflow>({ tag: 'paused' });
  const playing = playback.tag === 'playing';
  const setPlaying = (value: boolean) =>
    setPlayback({ tag: value ? 'playing' : 'paused' });
  const [mode, setMode] = useState<RenderMode>('ASCII');
  const [treatments, setTreatments] = useState<Record<RenderMode, Treatment>>({
    ASCII: defaultTreatment,
    Pixelated: defaultPixelatedTreatment,
  });
  const treatment = treatments[mode];
  const treatmentRef = useRef(treatment);
  treatmentRef.current = treatment;
  const publishPreview = useCallback(
    (timestamp: number, previewTreatment: Treatment = treatmentRef.current) => {
      if (!duration || !workerRef.current || exporting) return false;
      const sequence = ++previewSequenceRef.current;
      if (previewDiagnosticsEnabled) {
        readPreviewDiagnosticState()?.requests.push({
          sequence,
          timestamp,
          generationId: previewGenerationRef.current,
          sentAt: performance.now(),
        });
      }
      workerRef.current.postMessage({
        type: 'preview',
        timestamp,
        sequence,
        generationId: previewGenerationRef.current,
        treatment: previewTreatment,
      });
      return true;
    },
    [duration, exporting, previewDiagnosticsEnabled],
  );
  const setTreatment = (update: (current: Treatment) => Treatment) => {
    const updatedTreatment = update(treatmentRef.current);
    treatmentRef.current = updatedTreatment;
    previewGenerationRef.current++;
    dispatchGeneration({ type: 'invalidate' });
    setTreatments((current) => ({
      ...current,
      [mode]: updatedTreatment,
    }));
    if (playing)
      publishPreview(playbackTimeRef.current, updatedTreatment);
  };

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
    let lastPublished = previous;
    let lastUiUpdate = previous;
    let animationFrame = 0;
    const frameInterval = 1000 / Math.min(30, sourceFrameRateRef.current);
    if (previewDiagnosticsEnabled) {
      const diagnostics = readPreviewDiagnosticState();
      if (diagnostics) {
        diagnostics.playbackScheduler = {
          frameIntervalMs: frameInterval,
          ticks: 0,
          eligible: 0,
          published: 0,
        };
      }
    }
    const advance = (now: number) => {
      if (previewDiagnosticsEnabled) {
        const scheduler = readPreviewDiagnosticState()?.playbackScheduler;
        if (scheduler) scheduler.ticks++;
      }
      playbackTimeRef.current =
        (playbackTimeRef.current + (now - previous) / 1000) % duration;
      previous = now;
      if (now - lastPublished >= frameInterval - 1) {
        lastPublished += frameInterval;
        if (now - lastPublished >= frameInterval) lastPublished = now;
        if (previewDiagnosticsEnabled) {
          const scheduler = readPreviewDiagnosticState()?.playbackScheduler;
          if (scheduler) scheduler.eligible++;
        }
        const published = publishPreview(playbackTimeRef.current);
        if (published && previewDiagnosticsEnabled) {
          const scheduler = readPreviewDiagnosticState()?.playbackScheduler;
          if (scheduler) scheduler.published++;
        }
      }
      if (now - lastUiUpdate >= 250) {
        lastUiUpdate = now;
        setCurrentTime(playbackTimeRef.current);
      }
      animationFrame = window.requestAnimationFrame(advance);
    };
    animationFrame = window.requestAnimationFrame(advance);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [duration, exporting, playing, previewDiagnosticsEnabled, publishPreview]);

  useEffect(() => {
    if (!duration || exporting || playing) return;
    publishPreview(currentTime, treatment);
  }, [currentTime, duration, exporting, playing, publishPreview, treatment]);

  const chooseFile = (file?: File) => {
    if (!file || exporting || generatingBundle) return;
    if (file.size > 100_000_000) {
      setMessage(
        'This source video is larger than 100 MB (100,000,000 bytes). Choose a smaller file.',
      );
      return;
    }
    if (pendingWorkerRef.current) releaseWorker(pendingWorkerRef.current);
    setCandidate({ tag: 'checking', name: file.name });
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
      setCandidate({ tag: 'idle' });
      initialPreview?.close();
      releaseWorker(worker);
      setMessage(reason);
    };
    worker.onerror = () =>
      reject(
        'This file could not be read as a supported video. Choose an H.264 MP4.',
      );
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
      setCandidate({ tag: 'idle' });
      if (previous) releaseWorker(previous);
      previewSequenceRef.current = 0;
      previewGenerationRef.current++;
      displayedPreviewSequenceRef.current = -1;
      sourceFrameRateRef.current = reply.frameRate;
      if (previewDiagnosticsEnabled) {
        const diagnostics = readPreviewDiagnosticState();
        if (diagnostics) diagnostics.sourceFrameRate = reply.frameRate;
      }
      activeCodeBundleRef.current = undefined;
      codeBundleOperationIdRef.current++;
      setDownloadUrl((url) => {
        if (url) URL.revokeObjectURL(url);
        return '';
      });
      setBundleUrl('');
      setSource({
        tag: 'usable',
        name: file.name,
        duration: reply.duration,
        frameRate: reply.frameRate,
      });
      setCapabilities({
        mp4: 'checking',
        asciiCode:
          typeof CompressionStream === 'function' ? 'available' : 'unavailable',
      });
      dispatchGeneration({ type: 'invalidate' });
      setCurrentTime(0);
      playbackTimeRef.current = 0;
      setPlaying(false);
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
          const diagnostics = previewDiagnosticsEnabled
            ? readPreviewDiagnosticState()
            : undefined;
          const receivedAt = performance.now();
          const request = diagnostics?.requests.find(
            (item) =>
              item.sequence === activeReply.sequence &&
              item.generationId === activeReply.generationId,
          );
          diagnostics?.replies.push({
            sequence: activeReply.sequence,
            generationId: activeReply.generationId,
            receivedAt,
            ...(activeReply.diagnostics
              ? { diagnostics: activeReply.diagnostics }
              : {}),
          });
          if (
            activeReply.generationId !== previewGenerationRef.current ||
            activeReply.sequence <= displayedPreviewSequenceRef.current
          ) {
            diagnostics?.droppedReplies.push({
              sequence: activeReply.sequence,
              generationId: activeReply.generationId,
              reason:
                activeReply.generationId !== previewGenerationRef.current
                  ? 'invalidated-generation'
                  : 'non-monotonic-sequence',
            });
            activeReply.bitmap.close();
            return;
          }
          displayedPreviewSequenceRef.current = activeReply.sequence;
          const activeCanvas = canvasRef.current;
          if (activeCanvas) {
            activeCanvas.width = activeReply.bitmap.width;
            activeCanvas.height = activeReply.bitmap.height;
            const drawStartedAt = performance.now();
            activeCanvas.getContext('2d')?.drawImage(activeReply.bitmap, 0, 0);
            const presentedAt = performance.now();
            diagnostics?.presentations.push({
              sequence: activeReply.sequence,
              generationId: activeReply.generationId,
              requestToPresentationMs: request
                ? presentedAt - request.sentAt
                : null,
              replyToPresentationMs: presentedAt - receivedAt,
              drawImageMs: presentedAt - drawStartedAt,
            });
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
      if (previewDiagnosticsEnabled) {
        readPreviewDiagnosticState()?.requests.push({
          sequence: previewSequenceRef.current,
          timestamp: 0,
          generationId: previewGenerationRef.current,
          sentAt: performance.now(),
        });
      }
      worker.postMessage({
        type: 'preview',
        timestamp: 0,
        sequence: previewSequenceRef.current,
        generationId: previewGenerationRef.current,
        treatment: treatmentRef.current,
      });
      setMessage('Source video ready. Checking MP4 encoding support…');
      void (async () => {
        let supported = false;
        try {
          supported =
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
        } catch {
          supported = false;
        }
        if (workerRef.current !== worker) return;
        setCapabilities((current) => ({
          ...current,
          mp4: supported ? 'available' : 'unavailable',
        }));
        if (!supported)
          setMessage(
            'Source video ready. This browser cannot encode H.264 MP4 on this device.',
          );
        else setMessage('Source video ready.');
      })();
    };
    const testOptions = new URLSearchParams(window.location.search);
    worker.postMessage({
      type: 'load',
      file,
      previewDiagnostics: previewDiagnosticsEnabled,
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
      dispatchGeneration({
        type: 'progress',
        output: 'mp4',
        operationId: reply.operationId,
        value: reply.value,
      });
    } else if (reply.type === 'done') {
      if (reply.operationId !== activeExportRef.current) return;
      activeExportRef.current = undefined;
      if (generationRef.current.tag === 'canceling') {
        dispatchGeneration({
          type: 'cancelled',
          output: 'mp4',
          operationId: reply.operationId,
        });
        setMessage(
          'Export canceled. Your source video and settings are ready.',
        );
        return;
      }
      const url = URL.createObjectURL(
        new Blob([reply.bytes], { type: 'video/mp4' }),
      );
      dispatchGeneration({
        type: 'complete',
        output: 'mp4',
        operationId: reply.operationId,
        artifactUrl: url,
      });
      setDownloadUrl(url);
      setMessage('Your silent MP4 download was requested.');
      requestDownload(url, 'ascii-video.mp4');
    } else if (reply.type === 'code-bundle-progress') {
      if (activeCodeBundleRef.current !== reply.operationId) return;
      dispatchGeneration({
        type: 'progress',
        output: 'ascii-code',
        operationId: reply.operationId,
        value: reply.value,
      });
    } else if (reply.type === 'code-bundle-done') {
      if (activeCodeBundleRef.current !== reply.operationId) return;
      activeCodeBundleRef.current = undefined;
      if (generationRef.current.tag === 'canceling') {
        dispatchGeneration({
          type: 'cancelled',
          output: 'ascii-code',
          operationId: reply.operationId,
        });
        setMessage(
          'Generation canceled. Your source video and settings are ready to try again.',
        );
        return;
      }
      const url = URL.createObjectURL(
        new Blob([reply.bytes], { type: 'application/zip' }),
      );
      dispatchGeneration({
        type: 'complete',
        output: 'ascii-code',
        operationId: reply.operationId,
        artifactUrl: url,
      });
      setBundleUrl(url);
      setMessage('Your ASCII code bundle is ready. Download requested.');
      requestDownload(url, 'ascii-code-bundle.zip');
    } else if (reply.type === 'code-bundle-canceled') {
      if (activeCodeBundleRef.current !== reply.operationId) return;
      activeCodeBundleRef.current = undefined;
      dispatchGeneration({
        type: 'cancelled',
        output: 'ascii-code',
        operationId: reply.operationId,
      });
      setMessage(
        'Generation canceled. Your source video and settings are ready to try again.',
      );
    } else if (reply.type === 'canceled') {
      if (reply.operationId !== activeExportRef.current) return;
      activeExportRef.current = undefined;
      dispatchGeneration({
        type: 'cancelled',
        output: 'mp4',
        operationId: reply.operationId,
      });
      setMessage('Export canceled. Your source video and settings are ready.');
    } else if (reply.type === 'error') {
      if (reply.operationId === undefined) {
        if (reply.generationId !== previewGenerationRef.current) return;
        setMessage(`Preview failed: ${reply.message}`);
        return;
      }
      if (
        reply.operationId !== activeExportRef.current &&
        reply.operationId !== activeCodeBundleRef.current
      )
        return;
      const failedBundle =
        reply.operationId !== undefined &&
        activeCodeBundleRef.current === reply.operationId;
      if (generationRef.current.tag === 'canceling') {
        if (failedBundle) activeCodeBundleRef.current = undefined;
        else activeExportRef.current = undefined;
        dispatchGeneration({
          type: 'cancelled',
          output: failedBundle ? 'ascii-code' : 'mp4',
          operationId: reply.operationId,
        });
        setMessage(
          failedBundle
            ? 'Generation canceled. Your source video and settings are ready to try again.'
            : 'Export canceled. Your source video and settings are ready.',
        );
        return;
      }
      if (failedBundle) activeCodeBundleRef.current = undefined;
      else if (reply.operationId === activeExportRef.current)
        activeExportRef.current = undefined;
      dispatchGeneration({
        type: 'failed',
        output: failedBundle ? 'ascii-code' : 'mp4',
        operationId: reply.operationId,
        message: reply.message,
      });
      setMessage(
        failedBundle
          ? `Code generation failed: ${reply.message} You can try again.`
          : `Export failed: ${reply.message} You can try again.`,
      );
    }
  };

  const exportVideo = () => {
    if (!canExport || exporting || generatingBundle || !workerRef.current)
      return;
    setDownloadUrl((url) => {
      if (url) URL.revokeObjectURL(url);
      return '';
    });
    setPlaying(false);
    const operationId = ++exportOperationIdRef.current;
    activeExportRef.current = operationId;
    dispatchGeneration({ type: 'start', output: 'mp4', operationId });
    setMessage('Encoding on this device…');
    workerRef.current.postMessage({
      type: 'export',
      treatment: { ...treatment },
      operationId,
    });
  };

  const generateCodeBundle = () => {
    setPlaying(false);
    const operationId = ++codeBundleOperationIdRef.current;
    activeCodeBundleRef.current = operationId;
    dispatchGeneration({ type: 'start', output: 'ascii-code', operationId });
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
    dispatchGeneration({
      type: 'cancel-requested',
      output: 'mp4',
      operationId,
    });
    workerRef.current?.postMessage({ type: 'cancel-export', operationId });
  };

  const cancelCodeBundle = () => {
    const operationId = activeCodeBundleRef.current;
    if (operationId === undefined) return;
    dispatchGeneration({
      type: 'cancel-requested',
      output: 'ascii-code',
      operationId,
    });
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
                aria-label={
                  mode === 'ASCII' ? 'ASCII preview' : 'Pixelated preview'
                }
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
                onClick={() => {
                  if (playing) {
                    previewGenerationRef.current++;
                    dispatchGeneration({ type: 'invalidate' });
                    setCurrentTime(playbackTimeRef.current);
                  }
                  setPlaying(!playing);
                }}
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
                  previewGenerationRef.current++;
                  playbackTimeRef.current = time;
                  setCurrentTime(time);
                  if (playing)
                    publishPreview(time, treatmentRef.current);
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
              const nextMode = event.currentTarget.value as RenderMode;
              const nextTreatment = treatments[nextMode];
              previewGenerationRef.current++;
              dispatchGeneration({ type: 'invalidate' });
              treatmentRef.current = nextTreatment;
              setMode(nextMode);
              if (playing)
                publishPreview(playbackTimeRef.current, nextTreatment);
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
                Classic: varied ASCII ramp (space to $) · Minimal: space, dot,
                hash · Binary: space, 0, 1
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
                  setTreatment((current) => ({ ...current, brightness }));
                }}
              />
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
                  setTreatment((current) => ({ ...current, contrast }));
                }}
              />
              <label className={styles.checkboxLabel}>
                <input
                  aria-label="Invert brightness mapping"
                  type="checkbox"
                  checked={treatment.inverted}
                  disabled={controlsDisabled}
                  onChange={(event) => {
                    const inverted = event.currentTarget.checked;
                    setTreatment((current) => ({ ...current, inverted }));
                  }}
                />
                Invert brightness mapping
              </label>
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
              <p className={styles.note}>
                Brightness determines the size of each square cell.
              </p>
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
            disabled={
              !canGenerateBundle || controlsDisabled || mode !== 'ASCII'
            }
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
