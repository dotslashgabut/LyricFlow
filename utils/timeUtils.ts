import { SubtitleSegment } from '../types';

// Helper to pad numbers with leading zeros
const pad = (num: number, size: number): string => {
  return num.toString().padStart(size, '0');
};

// Format: HH:MM:SS,mmm (SRT Standard)
// Example: 00:00:28,106
export const formatToSRTTime = (seconds: number): string => {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const sec = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const min = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);

  return `${pad(hour, 2)}:${pad(min, 2)}:${pad(sec, 2)},${pad(ms, 3)}`;
};

// Format: [MM:SS.xx] (LRC Standard - centiseconds)
// Example: [00:28.19]
export const formatToLRCTime = (seconds: number): string => {
  // Round to nearest centisecond (1/100th of a second)
  const totalCentiseconds = Math.round(seconds * 100);
  
  const centis = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const sec = totalSeconds % 60;
  const min = Math.floor(totalSeconds / 60);

  // Standard LRC usually keeps minutes to 2 digits, but expands if needed.
  const minStr = pad(min, 2);
  const secStr = pad(sec, 2);
  const centiStr = pad(centis, 2);

  return `[${minStr}:${secStr}.${centiStr}]`;
};

// Format: MM:SS.mmm (For UI Display)
// Example: 00:28.106
export const formatToDisplayTime = (seconds: number): string => {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const sec = totalSeconds % 60;
  const min = Math.floor(totalSeconds / 60);

  return `${pad(min, 2)}:${pad(sec, 2)}.${pad(ms, 3)}`;
};

export const generateSRT = (segments: SubtitleSegment[]): string => {
  return segments.map((seg, index) => {
    return `${index + 1}\n${formatToSRTTime(seg.start)} --> ${formatToSRTTime(seg.end)}\n${seg.text}\n`;
  }).join('\n');
};

export const generateLRC = (segments: SubtitleSegment[], metadata?: { title?: string, artist?: string }): string => {
  let output = '';
  if (metadata?.title) output += `[ti:${metadata.title}]\n`;
  if (metadata?.artist) output += `[ar:${metadata.artist}]\n`;
  
  output += segments.map(seg => {
    return `${formatToLRCTime(seg.start)}${seg.text}`;
  }).join('\n');
  
  return output;
};

export const formatDuration = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};