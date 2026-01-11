
export interface SubtitleSegment {
  start: number; // Start time in seconds
  end: number;   // End time in seconds
  text: string;  // The content text
  words?: SubtitleSegment[]; // Optional nested segments for word-level timing
}

export enum AppState {
  IDLE = 'IDLE',
  RECORDING = 'RECORDING',
  READY = 'READY',
  PROCESSING = 'PROCESSING',
  EXPORTING = 'EXPORTING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

export type AudioSource = 'upload' | 'microphone';

export type AspectRatio = '16:9' | '9:16' | '3:4';

export type GeminiModel = 'gemini-3-flash-preview' | 'gemini-2.5-flash';

export type TranscriptionMode = 'line' | 'word';
