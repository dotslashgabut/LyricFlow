
import { SubtitleSegment } from '../types';

// Helper to pad numbers with leading zeros
const pad = (num: number, size: number): string => {
  return num.toString().padStart(size, '0');
};

// Format: HH:MM:SS,mmm (SRT Standard)
export const formatToSRTTime = (seconds: number): string => {
  if (isNaN(seconds) || seconds < 0) return "00:00:00,000";
  
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const sec = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const min = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);

  return `${pad(hour, 2)}:${pad(min, 2)}:${pad(sec, 2)},${pad(ms, 3)}`;
};

// Format: HH:MM:SS.mmm (TTML Standard)
export const formatToTTMLTime = (seconds: number): string => {
  if (isNaN(seconds) || seconds < 0) return "00:00:00.000";
  
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const sec = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const min = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);

  return `${pad(hour, 2)}:${pad(min, 2)}:${pad(sec, 2)}.${pad(ms, 3)}`;
};

// Format: [MM:SS.xx] (LRC Standard - centiseconds)
export const formatToLRCTime = (seconds: number): string => {
  if (isNaN(seconds) || seconds < 0) return "[00:00.00]";

  const totalCentiseconds = Math.round(seconds * 100);
  const centis = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const sec = totalSeconds % 60;
  const min = Math.floor(totalSeconds / 60);

  return `[${pad(min, 2)}:${pad(sec, 2)}.${pad(centis, 2)}]`;
};

// Format: MM:SS.mmm (For UI Display)
export const formatToDisplayTime = (seconds: number): string => {
  if (isNaN(seconds) || seconds < 0) return "00:00.000";

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

export const generateLRC = (
  segments: SubtitleSegment[], 
  metadata: { 
    title?: string; 
    artist?: string; 
    album?: string;
    by?: string;
  },
  audioDuration: number = 0
): string => {
  let lines: string[] = [];
  
  if (metadata.title) lines.push(`[ti:${metadata.title}]`);
  if (metadata.artist) lines.push(`[ar:${metadata.artist}]`);
  if (metadata.album) lines.push(`[al:${metadata.album}]`);
  lines.push(`[by:${metadata.by || 'LyricFlow AI'}]`);
  
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    lines.push(`${formatToLRCTime(seg.start)}${seg.text}`);
    
    // Logic for blank timestamp between segments (gap > 4s)
    if (i < segments.length - 1) {
      const nextSeg = segments[i + 1];
      const gap = nextSeg.start - seg.end;
      if (gap > 4.0) {
        lines.push(`${formatToLRCTime(seg.end + 1.0)}`); // Clear text 1s after segment ends
      }
    } else {
      // LAST LINE SPECIAL LOGIC:
      const targetBlankTime = seg.end + 4.0;
      if (audioDuration > 0 && targetBlankTime <= audioDuration) {
        lines.push(`${formatToLRCTime(targetBlankTime)}`);
      }
    }
  }
  
  return lines.join('\n');
};

export const generateTTML = (
  segments: SubtitleSegment[],
  metadata: { title?: string }
): string => {
  const title = metadata.title || "Lyrics";
  
  const bodyContent = segments.map((seg) => {
    const startStr = formatToTTMLTime(seg.start);
    const endStr = formatToTTMLTime(seg.end);

    // Escape XML special characters
    const escape = (str: string) => str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

    if (seg.words && seg.words.length > 0) {
      // Generate Word-level spans
      const spans = seg.words.map(word => {
        return `<span begin="${formatToTTMLTime(word.start)}" end="${formatToTTMLTime(word.end)}">${escape(word.text)} </span>`;
      }).join('\n        ');

      return `      <p begin="${startStr}" end="${endStr}">
        ${spans}
      </p>`;
    } else {
      // Fallback to simple line-level
      return `      <p begin="${startStr}" end="${endStr}">${escape(seg.text)}</p>`;
    }
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xml:lang="en">
  <head>
    <metadata>
      <ttm:title xmlns:ttm="http://www.w3.org/ns/ttml#metadata">${title}</ttm:title>
    </metadata>
    <styling>
      <style xml:id="s1" tts:fontSize="100%" tts:fontFamily="sansSerif" tts:color="white" />
    </styling>
  </head>
  <body>
    <div>
${bodyContent}
    </div>
  </body>
</tt>`;
};

export const formatDuration = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};
