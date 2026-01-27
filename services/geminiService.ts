
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
          id: {
            type: Type.INTEGER,
            description: "Sequential Segment ID (1, 2, 3...). MUST increment for every single line.",
          },
          startTime: {
            type: Type.STRING,
            description: "Start Timestamp (HH:MM:SS.mmm).",
          },
          endTime: {
            type: Type.STRING,
            description: "End Timestamp (HH:MM:SS.mmm).",
          },
          text: {
            type: Type.STRING,
            description: "Verbatim text content.",
          },
          words: {
            type: Type.ARRAY,
            description: "Word-level timing.",
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
        required: ["id", "startTime", "endTime", "text"],
      },
    },
  },
  required: ["segments"],
};

function normalizeTimestamp(ts: string): string {
  if (!ts) return "00:00:00.000";
  
  let clean = ts.trim().replace(/[^\d:.]/g, '');
  
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

function tryRepairJson(jsonString: string): any {
  let trimmed = jsonString.trim();
  trimmed = trimmed.replace(/^```json/, '').replace(/```$/, '').trim();

  try {
    return JSON.parse(trimmed);
  } catch (e) {
    console.warn("Initial JSON parse failed, attempting deep repair...");
  }

  if (trimmed.includes('"segments"')) {
    const lastClosingBrace = trimmed.lastIndexOf('}');
    const lastClosingBracket = trimmed.lastIndexOf(']');
    
    if (lastClosingBrace !== -1) {
      let candidate = trimmed.substring(0, lastClosingBrace + 1);
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

  throw new Error("Transcription response malformed. The conversation might be too complex or long.");
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
  
  // Both Gemini 2.5 and 3 series support thinking, which is critical for repetitive tasks.
  const supportsThinking = modelName.includes('gemini-3') || modelName.includes('gemini-2.5');

  const timingPolicy = `
    TIMING PRECISION RULES:
    1. FORMAT: strictly **HH:MM:SS.mmm** (e.g., 00:00:12.450).
    2. CHRONOLOGY: Timestamps must be strictly non-decreasing.
    3. START ZERO: The first segment MUST correspond to the very first audible word, even if it's at 00:00:00.500. Do not skip the intro.
  `;

  let modeInstructions = "";
  if (mode === 'word') {
    modeInstructions = `
    MODE: KARAOKE / WORD-LEVEL
    1. GRANULARITY: Output a "words" array for every segment.
    2. VERBATIM REPETITION: If the audio says "Go go go", you must output 3 distinct word objects.
    3. DENSITY: High density of timestamps is required. Do not merge.
    `;
  } else {
    modeInstructions = `
    MODE: SUBTITLE / LINE-LEVEL
    1. LINE BREAKS: Create a new segment for each phrase.
    2. VERBATIM REPETITION: If a line is repeated, output a NEW segment with a NEW ID.
    `;
  }

  const oneShotExample = `
    EXAMPLE OF REPETITIVE AUDIO HANDLING:
    Audio Content: (Starts at 0s) "Work it harder, make it better, do it faster, makes us stronger" (repeated twice)
    
    CORRECT OUTPUT STRUCTURE:
    {
      "segments": [
        { "id": 1, "startTime": "00:00:00.000", "endTime": "00:00:03.000", "text": "Work it harder, make it better, do it faster, makes us stronger" },
        { "id": 2, "startTime": "00:00:03.000", "endTime": "00:00:05.000", "text": "Work it harder, make it better, do it faster, makes us stronger" }
      ]
    }
  `;

  const systemInstructions = `
    ROLE: You are a Forensic Audio Transcription Logger.
    
    OBJECTIVE: 
    Convert audio to a structured JSON log.
    Your priority is COMPLETENESS and FIDELITY.
    
    ${timingPolicy}
    
    ${modeInstructions}

    CRITICAL RULES FOR REPETITIVE & INTRO CONTENT:
    1. **NO SKIPPING START**: Transcribe the very first words heard, even if they are ad-libs like "Yeah", "Uh", "Listen".
    2. **NO DEDUPLICATION**: If a phrase is spoken 50 times, you output 50 JSON segments.
    3. **NO SUMMARIES**: Never write "(chorus repeats)" or "(x10)".
    4. **SEQUENTIAL PROCESSING**: Start at the beginning. Log every utterance. End at the end.
    5. **ID TRACKING**: The schema requires an 'id'. Increment it: 1, 2, 3... This proves you are logging each instance individually.

    ${oneShotExample}

    OUTPUT:
    Return ONLY valid JSON.
  `;

  const requestConfig: any = {
    responseMimeType: "application/json",
    responseSchema: TRANSCRIPTION_SCHEMA,
    // Thinking models work better with slight temperature for reasoning tasks
    temperature: 0.3,
    maxOutputTokens: 8192,
    topP: 0.95,
    safetySettings: [
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ]
  };

  if (supportsThinking) {
    // 2048 allows sufficient reasoning depth for counting repetitions and mapping complex song structures
    // without eating too much into the 8192 output budget.
    requestConfig.thinkingConfig = { thinkingBudget: 2048 }; 
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
