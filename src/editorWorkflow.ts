export type OutputKind = 'mp4' | 'ascii-code';

export type GenerationWorkflow =
  | { tag: 'idle' }
  | {
      tag: 'running' | 'canceling';
      output: OutputKind;
      operationId: number;
      progress: number;
    }
  | { tag: 'completed'; output: OutputKind; artifactUrl: string }
  | { tag: 'failed'; output: OutputKind; message: string };

export type GenerationAction =
  | { type: 'start'; output: OutputKind; operationId: number }
  | { type: 'progress'; output: OutputKind; operationId: number; value: number }
  | { type: 'cancel-requested'; output: OutputKind; operationId: number }
  | { type: 'complete'; output: OutputKind; operationId: number; artifactUrl: string }
  | { type: 'cancelled'; output: OutputKind; operationId: number }
  | { type: 'failed'; output: OutputKind; operationId: number; message: string }
  | { type: 'invalidate' };

export const initialGenerationWorkflow: GenerationWorkflow = { tag: 'idle' };

export function generationWorkflowReducer(
  state: GenerationWorkflow,
  action: GenerationAction,
): GenerationWorkflow {
  if (action.type === 'invalidate') return { tag: 'idle' };
  if (action.type === 'start') {
    if (state.tag === 'running' || state.tag === 'canceling') return state;
    return {
      tag: 'running',
      output: action.output,
      operationId: action.operationId,
      progress: 0,
    };
  }
  if (
    (state.tag !== 'running' && state.tag !== 'canceling') ||
    state.output !== action.output ||
    state.operationId !== action.operationId
  )
    return state;
  switch (action.type) {
    case 'progress':
      if (state.tag === 'canceling') return state;
      return { ...state, progress: Math.max(0, Math.min(1, action.value)) };
    case 'cancel-requested':
      return { ...state, tag: 'canceling' };
    case 'complete':
      if (state.tag === 'canceling') return { tag: 'idle' };
      return { tag: 'completed', output: action.output, artifactUrl: action.artifactUrl };
    case 'cancelled':
      return { tag: 'idle' };
    case 'failed':
      return { tag: 'failed', output: action.output, message: action.message };
  }
}

export function isGenerationActive(state: GenerationWorkflow) {
  return state.tag === 'running' || state.tag === 'canceling';
}
