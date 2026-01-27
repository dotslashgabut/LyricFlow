
import { GoogleGenAI, Type } from "@google/genai";
import { SubtitleSegment, GeminiModel, TranscriptionMode } from "../types";

// Dynamic schema generation to reduce token load and complexity for the model
const getTranscriptionSchema = (mode: TranscriptionMode) => {
  const segmentProperties: any = {
    id: {
      type: Type.INTEGER,
      description: "Sequential ID (1, 2, 3...).",
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
      description: "Verbatim text.",
    }
  };

  const requiredProps = ["id", "startTime", "endTime", "text"];

  if (mode === 'word') {
    segmentProperties.words = {
      type: Type.ARRAY,
      description: "Word-level timing.",
      items: {
        type: Type.OBJECT,
        properties: {
          startTime: { type: Type.STRING },
          endTime: { type: Type.STRING },
          text: { type: Type.STRING }
        },
        required: ["startTime", "endTime", "text"]
      }
    };
    requiredProps.push("words");
  }

  return {
    type: Type.OBJECT,
    properties: {
      segments: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: segmentProperties,
          required: requiredProps,
        },
      },
    },
    required: ["segments"],
  };
};

function normalizeTimestamp(ts: string): string {
  if (!ts) return "00:00:00.000";
  
  let clean = ts.trim().replace(/[^\d:.]/g, '');
  
  // Handle raw seconds (e.g. "12.5")
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
  
  // CRITICAL FIX: Gemini 2.5 Flash works BEST as a raw machine for ASR without 'thinking'.
  // 'Thinking' on 2.5 Flash for repetitive audio often leads to hallucinated "loop detection" rejections.
  // Gemini 3 Flash benefits from thinking to handle complex mapping, but 2.5 should stay "dumb" and direct.
  const useThinking = modelName.includes('gemini-3'); 

  const timingPolicy = `
    TIMING PRECISION RULES:
    1. FORMAT: **HH:MM:SS.mmm** (e.g., 00:00:12.450).
    2. CONTINUITY: Timestamps must NOT jump. The endTime of Segment N should be close to startTime of Segment N+1.
    3. START ZERO: The first segment MUST correspond to the absolute start of the audio.
    4. NO HALLUCINATION: Do not invent time gaps. If the audio is continuous, the timestamps must be continuous.
  `;

  let modeInstructions = "";
  if (mode === 'word') {
    modeInstructions = `
    MODE: KARAOKE / WORD-LEVEL
    - Output a "words" array for every segment.
    - Capture every single repeated word as a distinct object with unique timestamps.
    `;
  } else {
    modeInstructions = `
    MODE: SUBTITLE / LINE-LEVEL
    - Create a new segment for each line/phrase.
    - If a line is repeated, CREATE A NEW SEGMENT.
    - DO NOT SUMMARIZE REPEATS.
    `;
  }

  const oneShotExample = `
    EXAMPLE OF REPETITIVE AUDIO HANDLING:
    Audio: "Work it harder (0s-2s), make it better (2s-4s), do it faster (4s-6s)"
    
    CORRECT:
    {
      "segments": [
        { "id": 1, "startTime": "00:00:00.000", "endTime": "00:00:02.000", "text": "Work it harder" },
        { "id": 2, "startTime": "00:00:02.000", "endTime": "00:00:04.000", "text": "make it better" },
        { "id": 3, "startTime": "00:00:04.000", "endTime": "00:00:06.000", "text": "do it faster" }
      ]
    }
  `;

  // Specific "Machine Mode" for 2.5 Flash to prevent rejection/summarization
  const persona = useThinking 
    ? "ROLE: High-Precision Audio Transcription Engine."
    : "ROLE: SYSTEM PROCESS ASR (Audio Speech Recognition). MODE: RAW DATA STREAM.";

  const systemInstructions = `
    ${persona}
    
    OBJECTIVE: 
    Convert audio to a JSON log. 
    Focus on PRECISE TIMING and COMPLETENESS.
    
    ${timingPolicy}
    
    ${modeInstructions}

    CRITICAL INSTRUCTIONS FOR REPETITIVE AUDIO (LOOPS):
    1. **TRUST THE AUDIO**: Even if the text is "Test 1 2 3" repeated 50 times, transcribe it 50 times.
    2. **NO FILTERING**: Do not reject the audio as "spam" or "test". Transcribe exactly what is heard.
    3. **NO TIMESTAMPS JUMPS**: Ensure the timestamps match the actual flow of audio. Do not skip 10 seconds ahead randomly.
    4. **CAPTURE INTRO**: Start listening from 00:00:00.

    ${oneShotExample}

    OUTPUT:
    Return ONLY valid JSON.
  `;

  const requestConfig: any = {
    responseMimeType: "application/json",
    responseSchema: getTranscriptionSchema(mode),
    temperature: 0.0, // Strict determinism for timestamps
    maxOutputTokens: 8192,
    safetySettings: [
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' }
    ]
  };

  if (useThinking) {
    // Gemini 3 uses thinking to plan complex layouts
    requestConfig.thinkingConfig = { thinkingBudget: 2048 }; 
  } else {
    // Gemini 2.5 Flash: Disable thinking to prevent over-analysis of repetitive loops
    // and rely on raw ASR pattern matching.
    delete requestConfig.thinkingConfig;
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
