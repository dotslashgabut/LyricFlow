
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
            description: "Line/Phrase Start Timestamp in HH:MM:SS.mmm format.",
          },
          endTime: {
            type: Type.STRING,
            description: "Line/Phrase End Timestamp in HH:MM:SS.mmm format.",
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
                startTime: { type: Type.STRING, description: "Word Start HH:MM:SS.mmm" },
                endTime: { type: Type.STRING, description: "Word End HH:MM:SS.mmm" },
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
  
  // Handle if model returns raw seconds (e.g. "65.5") 
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

  // Handle M:S.mmm, MM:SS.mmm or HH:MM:SS.mmm
  const parts = clean.split(':');
  let h = 0, m = 0, s = 0, ms = 0;

  if (parts.length === 3) {
    h = parseInt(parts[0], 10) || 0;
    m = parseInt(parts[1], 10) || 0;
    const secParts = parts[2].split('.');
    s = parseInt(secParts[0], 10) || 0;
    if (secParts[1]) {
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
  } else if (parts.length === 1) {
    const secParts = parts[0].split('.');
    s = parseInt(secParts[0], 10) || 0;
    if (secParts[1]) {
      const msStr = secParts[1].substring(0, 3).padEnd(3, '0');
      ms = parseInt(msStr, 10);
    }
  }

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/**
 * Attempts to repair truncated or malformed JSON strings.
 */
function tryRepairJson(jsonString: string): any {
  let trimmed = jsonString.trim();
  
  // Strip markdown formatting if the model used it
  trimmed = trimmed.replace(/^```json/, '').replace(/```$/, '').trim();

  try {
    return JSON.parse(trimmed);
  } catch (e) {
    console.warn("Initial JSON parse failed, attempting deep repair...");
  }

  // 1. Check if the segments list is there but the closing braces are missing
  if (trimmed.includes('"segments"')) {
    const lastClosingBrace = trimmed.lastIndexOf('}');
    const lastClosingBracket = trimmed.lastIndexOf(']');
    
    // If we have at least one object closed, we can try to truncate the partial one
    if (lastClosingBrace !== -1) {
      let candidate = trimmed.substring(0, lastClosingBrace + 1);
      // Close the array and the object
      if (lastClosingBracket < lastClosingBrace) {
        candidate += ']}';
      } else {
        candidate += '}';
      }
      
      try {
        const parsed = JSON.parse(candidate);
        if (parsed.segments) return parsed;
      } catch (err) {}
    }
  }

  // 2. Bruteforce search for the largest valid array within the string
  const arrayStart = trimmed.indexOf('[');
  if (arrayStart !== -1) {
    for (let i = trimmed.length; i > arrayStart; i--) {
      try {
        const sub = trimmed.substring(arrayStart, i);
        const parsed = JSON.parse(sub);
        if (Array.isArray(parsed)) return { segments: parsed };
      } catch (err) {}
    }
  }

  throw new Error("Transcription response malformed. The conversation might be too complex or long. Try using a shorter clip or a different granularity.");
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
    TIMING PRECISION RULES:
    1. FORMAT: strictly **HH:MM:SS.mmm** (e.g., 00:00:12.450).
    2. CHRONOLOGY: Timestamps must be strictly non-decreasing.
    3. NO OVERLAPS: Segment [n].endTime must be <= Segment [n+1].startTime.
  `;

  let modeInstructions = "";

  if (mode === 'word') {
    modeInstructions = `
    KARAOKE/WORD-LEVEL MODE:
    1. VERBATIM REPETITIONS: In conversational media, people often repeat words (e.g., "Wait, wait, let me..."). You MUST transcribe every instance of "wait".
    2. UNIQUE WORD TIMESTAMPS: Every repeated word MUST have its own start/end time corresponding to its occurrence in the audio.
    3. HIERARCHY: Every word in the "words" array must fall strictly within the startTime/endTime of its parent segment.
    4. CONVERSATIONAL FILLERS: Always include "uh", "um", "ah", etc.
    `;
  } else {
    modeInstructions = `
    SUBTITLE/LINE-LEVEL MODE:
    1. READABILITY: Group speech into readable phrases (approx 2-6 seconds).
    2. CONVERSATIONAL FLOW: Keep short repetitions (e.g., "Wait, wait") in the same segment.
    3. BACKCHANNELING: Include acknowledgments ("Yeah", "Okay") if they don't break the flow.
    4. NO SUMMARIZATION: Never skip repeated speech.
    `;
  }

  const systemInstructions = `
    You are a professional Court Reporter and Synchronizer. 
    Your goal is to transcribe conversational media (audio/video) with 100% VERBATIM fidelity.

    TASK: Convert the media into a JSON object with timed segments.
    
    ${timingPolicy}
    
    ${modeInstructions}

    CRITICAL RULES FOR LONG CONVERSATIONS (PREVENT SKIPPING):
    1. **LINEAR PROCESSING**: Process the audio chronologically from 00:00:00 to the very end. Do NOT skip sections, do not summarize "boring" parts.
    2. **REPEATED WORDS**: If a speaker stammers (e.g., "I- I- I- I didn't"), you MUST generate a separate word object for EACH repetition. Do NOT merge them into one "I".
    3. **DISFLUENCIES**: Transcribe "um", "uh", "er" exactly as spoken.
    4. **NO HALLUCINATIONS**: Only transcribe what is audible.
    5. **COMPLETE**: Ensure the last spoken sentence is included.

    OUTPUT: Return ONLY a valid JSON object.
  `;

  // Configuration optimized for long-form transcription
  const requestConfig: any = {
    responseMimeType: "application/json",
    responseSchema: TRANSCRIPTION_SCHEMA,
    temperature: 0.0,
    maxOutputTokens: 8192, // Maximize token budget for long JSON output
  };

  if (isGemini3) {
    // Only use thinking for Gemini 3. 
    // Reduced to 1024 to save tokens for output while maintaining reasoning.
    requestConfig.thinkingConfig = { thinkingBudget: 1024 }; 
  }
  // Note: gemini-2.5-flash will utilize standard processing without thinkingConfig,
  // but will benefit from the high maxOutputTokens and strict system instructions.

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
    const rawData = tryRepairJson(text);

    if (!rawData.segments || !Array.isArray(rawData.segments)) {
      throw new Error("Invalid transcription format received.");
    }

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
           })).sort((a: any, b: any) => a.start - b.start);
        }

        return segment;
    }).sort((a: SubtitleSegment, b: SubtitleSegment) => a.start - b.start);

  } catch (error) {
    console.error("Transcription API Failure:", error);
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
