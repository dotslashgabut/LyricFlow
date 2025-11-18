export interface SubtitleSegment {
  start: number; // Start time in seconds
  end: number;   // End time in seconds
  text: string;  // The content text
}

export enum AppState {
  IDLE = 'IDLE',
  RECORDING = 'RECORDING',
  READY = 'READY',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

export type AudioSource = 'upload' | 'microphone';