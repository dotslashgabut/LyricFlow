
import { GoogleGenAI, Type } from "@google/genai";
import { SubtitleSegment, GeminiModel, TranscriptionMode } from "../types";

const TRANSCRIPTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          startTime: {
            type: Type.STRING,
            description: "Line/Phrase Start Timestamp in MM:SS.mmm format.",
          },
          endTime: {
            type: Type.STRING,
            description: "Line/Phrase End Timestamp in MM:SS.mmm format.",
          },
          text: {
            type: Type.STRING,
            description: "The full text of the line/phrase.",
          },
          words: {
            type: Type.ARRAY,
            description: "Array of individual words within this line.",
            items: {
              type: Type.OBJECT,
              properties: {
                startTime: { type: Type.STRING, description: "Word Start MM:SS.mmm" },
                endTime: { type: Type.STRING, description: "Word End MM:SS.mmm" },
                text: { type: Type.STRING, description: "The individual word" }
              },
              required: ["startTime", "endTime", "text"]
            }
          }
        },
        required: ["startTime", "endTime", "text"],
      },
    },
  },
  required: ["segments"],
};

/**
 * Robustly normalizes timestamp strings to HH:MM:SS.mmm
 */
function normalizeTimestamp(ts: string): string {
  if (!ts) return "00:00:00.000";
  
  let clean = ts.trim().replace(/[^\d:.]/g, '');
  
  // Handle if model returns raw seconds (e.g. "65.5") despite instructions
  if (!clean.includes(':') && /^[\d.]+$/.test(clean)) {
    const totalSeconds = parseFloat(clean);
    if (!isNaN(totalSeconds)) {
       const h = Math.floor(totalSeconds / 3600);
       const m = Math.floor((totalSeconds % 3600) / 60);
       const s = Math.floor(totalSeconds % 60);
       const ms = Math.round((totalSeconds % 1) * 1000);
       return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    }
  }

  // Handle MM:SS.mmm or HH:MM:SS.mmm
  const parts = clean.split(':');
  let h = 0, m = 0, s = 0, ms = 0;

  if (parts.length === 3) {
    h = parseInt(parts[0], 10) || 0;
    m = parseInt(parts[1], 10) || 0;
    const secParts = parts[2].split('.');
    s = parseInt(secParts[0], 10) || 0;
    if (secParts[1]) {
      // Pad or truncate to 3 digits for parsing
      const msStr = secParts[1].substring(0, 3).padEnd(3, '0');
      ms = parseInt(msStr, 10);
    }
  } else if (parts.length === 2) {
    m = parseInt(parts[0], 10) || 0;
    const secParts = parts[1].split('.');
    s = parseInt(secParts[0], 10) || 0;
    if (secParts[1]) {
      const msStr = secParts[1].substring(0, 3).padEnd(3, '0');
      ms = parseInt(msStr, 10);
    }
  } else {
    // Fallback if parsing fails
    return "00:00:00.000";
  }

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/**
 * Attempts to repair truncated JSON strings.
 */
function tryRepairJson(jsonString: string): any {
  const trimmed = jsonString.trim();

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.segments && Array.isArray(parsed.segments)) {
      return parsed;
    }
    // Handle case where it might be just the array
    if (Array.isArray(parsed)) {
      return { segments: parsed };
    }
  } catch (e) {
    // Continue
  }

  // Attempt to close truncated JSON
  const lastObjectEnd = trimmed.lastIndexOf('}');
  if (lastObjectEnd !== -1) {
    const repaired = trimmed.substring(0, lastObjectEnd + 1) + "]}";
    try {
      const parsed = JSON.parse(repaired);
      if (parsed.segments && Array.isArray(parsed.segments)) {
        return parsed;
      }
    } catch (e) {
      // Continue
    }
  }
  
  throw new Error("Response structure invalid and could not be repaired.");
}

function timestampToSeconds(ts: string): number {
  const parts = ts.split(':');
  if (parts.length === 3) {
      const h = parseFloat(parts[0]);
      const m = parseFloat(parts[1]);
      const s = parseFloat(parts[2]);
      return (h * 3600) + (m * 60) + s;
  }
  return 0;
}

export const transcribeAudio = async (
  base64Audio: string,
  mimeType: string,
  modelName: GeminiModel,
  mode: TranscriptionMode = 'line'
): Promise<SubtitleSegment[]> => {
  if (!process.env.API_KEY) {
    throw new Error("API Key is missing. Please check your environment configuration.");
  }

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const isGemini3 = modelName.includes('gemini-3');

  const timingPolicy = `
    TIMING RULES:
    1. FORMAT: strictly **MM:SS.mmm** (e.g., 01:23.450).
    2. CONTINUITY: Timestamps must be strictly chronological.
    3. ACCURACY: Sync text exactly to the audio.
  `;

  let segmentationPolicy = "";

  if (mode === 'word') {
    segmentationPolicy = `
    SEGMENTATION: HIERARCHICAL WORD-LEVEL (TTML/KARAOKE)
    ---------------------------------------------------
    CRITICAL: You are generating data for rich TTML export.
    
    1. STRUCTURE: Group words into natural lines/phrases (this is the parent object).
    2. DETAILS: Inside each line object, you MUST provide a "words" array.
    3. WORDS: The "words" array must contain EVERY single word from that line with its own precise start/end time.
    
    EXAMPLE STRUCTURE:
    {
      "startTime": "00:12.011", "endTime": "00:15.041", "text": "I thought that you remember",
      "words": [
        {"startTime": "00:12.011", "endTime": "00:12.176", "text": "I"},
        {"startTime": "00:12.176", "endTime": "00:12.293", "text": "thought"},
        ...
      ]
    }
    `;
  } else {
    segmentationPolicy = `
    SEGMENTATION: LINE-LEVEL (SUBTITLE/LRC MODE)
    ---------------------------------------------------
    CRITICAL: You are generating subtitles for a movie/music video.

    1. PHRASES: Group words into complete sentences or musical phrases.
    2. CLARITY: Do not break a sentence in the middle unless there is a pause.
    3. REPETITIONS: Separate repetitive vocalizations (e.g. "Oh oh oh") from the main lyrics into their own lines.
    4. LENGTH: Keep segments between 2 and 6 seconds for readability.
    5. WORDS ARRAY: You may omit the "words" array in this mode to save tokens.
    `;
  }

  const systemInstructions = `
    You are an expert Audio Transcription AI specialized in generating timed lyrics.
    
    TASK: Transcribe the audio file into JSON segments.
    MODE: ${mode.toUpperCase()} LEVEL.
    
    ${timingPolicy}
    
    ${segmentationPolicy}
    
    GENERAL RULES:
    - Verbatim: Transcribe exactly what is heard. Include fillers (um, ah) if sung.
    - Completeness: Transcribe from 00:00 to the very end. Do not summarize.
    - JSON Only: Output pure JSON. No markdown fences.
  `;

  const requestConfig: any = {
    responseMimeType: "application/json",
    responseSchema: TRANSCRIPTION_SCHEMA,
    temperature: 0.1, 
  };

  if (isGemini3) {
    requestConfig.thinkingConfig = { thinkingBudget: 1024 }; 
  }

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [
        {
          parts: [
            {
              inlineData: {
                data: base64Audio,
                mimeType: mimeType,
              },
            },
            {
              text: systemInstructions,
            },
          ],
        },
      ],
      config: requestConfig,
    });

    const text = response.text || "";
    const cleanText = text.replace(/```json|```/g, "").trim();
    const rawData = tryRepairJson(cleanText);

    return rawData.segments.map((seg: any) => {
        const startStr = normalizeTimestamp(seg.startTime);
        const endStr = normalizeTimestamp(seg.endTime);
        
        const segment: SubtitleSegment = {
            start: timestampToSeconds(startStr),
            end: timestampToSeconds(endStr),
            text: seg.text,
            words: []
        };

        if (seg.words && Array.isArray(seg.words)) {
           segment.words = seg.words.map((w: any) => ({
             start: timestampToSeconds(normalizeTimestamp(w.startTime)),
             end: timestampToSeconds(normalizeTimestamp(w.endTime)),
             text: w.text
           })).sort((a: SubtitleSegment, b: SubtitleSegment) => a.start - b.start);
        }

        return segment;
    }).sort((a: SubtitleSegment, b: SubtitleSegment) => a.start - b.start);

  } catch (error) {
    console.error("Transcription pipeline error:", error);
    throw error;
  }
};

export const fileToBase64 = (file: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
  });
};
