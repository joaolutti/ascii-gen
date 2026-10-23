export type CharacterPreset = 'Classic' | 'Minimal' | 'Binary';
export type RenderMode = 'ASCII' | 'Pixelated';

export type Treatment = {
  mode: RenderMode;
  density: number;
  gridStep: number;
  spacing: number;
  brightness: number;
  contrast: number;
  inverted: boolean;
  preset: CharacterPreset;
  foreground: string;
  background: string;
  sourceColor: boolean;
};
