
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
  
  // Replace comma with dot for standardizing (SRT uses comma, model might output it)
  let clean = ts.trim().replace(',', '.').replace(/[^\d:.]/g, '');
  
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
  // 1. Clean Markdown
  const jsonPattern = /```json([\s\S]*?)```/i;
  let clean = jsonString;
  const match = jsonString.match(jsonPattern);
  if (match) {
    clean = match[1];
  } else {
    clean = jsonString.replace(/^```json/i, '').replace(/```$/i, '');
  }
  clean = clean.trim();

  // 2. Try Direct Parse
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.warn("Initial JSON parse failed, attempting repairs...");
  }

  // 3. Find valid JSON substring (Start from the first '{')
  const firstBrace = clean.indexOf('{');
  if (firstBrace === -1) {
    throw new Error("No JSON structure found in response.");
  }

  // We search for the LAST closing brace '}'.
  // If parsing fails, we might be dealing with truncation or extra garbage at the end.
  // We iteratively try to parse substrings ending at different '}' positions.
  
  let endIdx = clean.lastIndexOf('}');
  
  // Safety valve: only try the last few closing braces to avoid performance issues on huge strings
  let attempts = 0;
  
  while (endIdx > firstBrace && attempts < 10) {
    const candidate = clean.substring(firstBrace, endIdx + 1);
    
    // Attempt 1: Just the substring
    try {
      return JSON.parse(candidate);
    } catch(e) {}

    // Attempt 2: Truncated array? Try adding ']}'
    // Only if it looks like we are inside a segments array
    if (candidate.includes('"segments"')) {
       try {
         return JSON.parse(candidate + ']}');
       } catch(e) {}
    }

    // Move to the previous closing brace
    endIdx = clean.lastIndexOf('}', endIdx - 1);
    attempts++;
  }

  throw new Error("Transcription response malformed and unrecoverable.");
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
  
  const useThinking = modelName.includes('gemini-3'); 

  const timingPolicy = `
    TIMING PRECISION RULES:
    1. FORMAT: **HH:MM:SS.mmm** (e.g., 00:00:12.450).
    2. CONTINUITY: Timestamps must NOT jump. The endTime of Segment N should be close to startTime of Segment N+1.
    3. START ZERO: The first segment MUST correspond to the absolute start of the audio.
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
    MODE: SUBTITLE / LYRICS (LINE-LEVEL)
    - OPTIMIZE FOR MUSIC LYRICS: Break text into short, rhythmic lines (max 5-8 words).
    - STRICTLY AVOID long blocks of text. If a sentence is long, split it based on the musical phrasing or pauses.
    - PRESERVE REPETITIONS: If a chorus repeats, transcribe it fully again with new timestamps.
    - DO NOT SUMMARIZE.
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
    temperature: 0.0,
    maxOutputTokens: 8192,
  };

  if (useThinking) {
    // Gemini 3 uses thinking to plan complex layouts
    requestConfig.thinkingConfig = { thinkingBudget: 2048 }; 
  } else {
    // Gemini 2.5 Flash: Disable thinking
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
