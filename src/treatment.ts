export type CharacterPreset = 'Classic' | 'Minimal' | 'Binary';

export type Treatment = {
  density: number;
  brightness: number;
  contrast: number;
  inverted: boolean;
  preset: CharacterPreset;
  foreground: string;
  background: string;
  sourceColor: boolean;
};
