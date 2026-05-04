
import { GoogleGenAI, Type, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { SubtitleSegment, GeminiModel, TranscriptionMode } from "../types";

// Schemas matching the sample logic for better structural integrity
const TRANSCRIPTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          startTime: {
            type: Type.NUMBER,
            description: "Absolute start time purely in fractional seconds (e.g. 1.500).",
          },
          endTime: {
            type: Type.NUMBER,
            description: "Absolute end time purely in fractional seconds.",
          },
          text: {
            type: Type.STRING,
            description: "Transcribed text.",
          },
        },
        required: ["startTime", "endTime", "text"],
      },
    },
  },
  required: ["segments"],
};

const WORD_LEVEL_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          startTime: { type: Type.NUMBER, description: "Start time purely in fractional seconds (e.g., 1.500)" },
          endTime: { type: Type.NUMBER, description: "End time purely in fractional seconds" },
          text: { type: Type.STRING },
          words: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                text: { type: Type.STRING },
                startTime: { type: Type.NUMBER, description: "Word start time purely in fractional seconds (e.g., 1.620)" },
                endTime: { type: Type.NUMBER, description: "Word end time purely in fractional seconds" }
              },
              required: ["text", "startTime", "endTime"]
            }
          }
        },
        required: ["startTime", "endTime", "text", "words"],
      },
    },
  },
  required: ["segments"],
};

// Helper to robustly parse strings or numbers to float seconds
function parseTimeToSeconds(ts: string | number): number {
  if (typeof ts === 'number') {
    if (isNaN(ts) || ts < 0) return 0;
    return ts;
  }
  if (!ts) return 0;

  // Replace comma with dot for SRT-style compatibility and remove non-essential chars
  let clean = ts.trim().replace(/,/g, '.').replace(/[^\d:.]/g, '');
  
  let totalSeconds = 0;

  if (clean.includes(':')) {
    const parts = clean.split(':');
    if (parts.length === 3) {
      // HH:MM:SS.mmm
      const h = parseFloat(parts[0]) || 0;
      const m = parseFloat(parts[1]) || 0;
      const s = parseFloat(parts[2]) || 0;
      totalSeconds = h * 3600 + m * 60 + s;
    } else if (parts.length === 2) {
      // MM:SS.mmm
      const m = parseFloat(parts[0]) || 0;
      const s = parseFloat(parts[1]) || 0;
      totalSeconds = m * 60 + s;
    } else {
      totalSeconds = parseFloat(clean) || 0;
    }
  } else {
    // Raw seconds
    totalSeconds = parseFloat(clean) || 0;
  }

  if (isNaN(totalSeconds) || totalSeconds < 0) return 0;

  return totalSeconds;
}

// Improved JSON repair logic
function tryRepairJson(jsonString: string): any {
  const trimmed = jsonString.trim();

  // 1. Try direct parse
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.segments && Array.isArray(parsed.segments)) return parsed;
    if (Array.isArray(parsed)) return { segments: parsed };
  } catch (e) {}

  // 2. Try closing truncated JSON
  const lastObjectEnd = trimmed.lastIndexOf('}');
  if (lastObjectEnd !== -1) {
    const suffixes = ["]}", "}", "]}"];
    for (const suffix of suffixes) {
      try {
        const repaired = trimmed + suffix;
        const parsed = JSON.parse(repaired);
        if (parsed.segments) return parsed;
      } catch (e) {}
    }

    // Try cutting off at last valid } and closing
    const candidate = trimmed.substring(0, lastObjectEnd + 1);
    if (candidate.includes('"segments"')) {
        try {
            return JSON.parse(candidate + ']}');
        } catch(e) {}
    }
  }

  // 3. Regex Fallback (Last Resort)
  const segments = [];
  const segmentRegex = /\{\s*"startTime"\s*:\s*([\d.]+)\s*,\s*"endTime"\s*:\s*([\d.]+)\s*,\s*"text"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  
  let match;
  while ((match = segmentRegex.exec(trimmed)) !== null) {
    const rawText = match[3] !== undefined ? match[3] : match[4];
    let unescapedText = rawText;
    try {
        // Attempt to unescape JSON string
        unescapedText = JSON.parse(`"${rawText.replace(/"/g, '\\"')}"`);
    } catch (e) {
        unescapedText = rawText;
    }

    segments.push({
      startTime: match[1],
      endTime: match[2],
      text: unescapedText
    });
  }

  if (segments.length > 0) return { segments };

  throw new Error("Response structure invalid and could not be repaired.");
}

export const transcribeAudio = async (
  base64Audio: string,
  mimeType: string,
  modelName: GeminiModel,
  mode: TranscriptionMode = 'line',
  duration?: number
): Promise<SubtitleSegment[]> => {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("API Key is missing. Please check your environment configuration.");
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // Policy instructions inspired by the sample code for better quality
  const durationHint = duration ? `TOTAL_AUDIO_DURATION: ${duration.toFixed(3)} seconds. All timestamps MUST be within [0, ${duration.toFixed(3)}].` : "";
  
  const timingPolicy = `
    TIMING RULES (STRICT ABSOLUTE TIME IN SECONDS):
    1. FORMAT: strictly fractional seconds (e.g., 2.500 or 15.340). DO NOT use string formats like 00:01:23.
    2. DRIFT PREVENTION: You MUST use decimal precision up to 3 places.
    3. ABSOLUTE: Timestamps correspond to the absolute time offset from the very beginning (0.000) of the file in SECONDS.
    4. START POINT: The first segment MUST start at 0.000 unless there is a long leading silence.
    5. CONTINUITY: Timestamps must be strictly chronological. Segment N start >= Segment N-1 end.
    6. PRECISION: For fast speech/rap, ensure word-level timestamps are millisecond-accurate relative to the segment.
    7. BOUNDARY: ${durationHint || "All timestamps must be within the actual audio duration in seconds."}
  `;

  let segmentationPolicy = "";

  if (mode === 'word') {
    segmentationPolicy = `
    SEGMENTATION: HIERARCHICAL WORD-LEVEL (TTML/KARAOKE/Enhanced LRC)
    ---------------------------------------------------
    CRITICAL: You are generating data for rich TTML or Karaoke display.
    
    1. STRUCTURE: Group words into short, natural lines/phrases (this is the parent object).
    2. LINE LENGTH: **CRITICAL** Keep lines SHORT (approx 3-8 words). Split long sentences into multiple lines.
    3. REPEATED WORDS & STUTTERS: **EXTREMELY IMPORTANT**
       - Treat every spoken utterance as a distinct word which must be timestamped.
       - NEVER merge repeated words into a single event.
    4. DETAILS: Inside each line object, you MUST provide a "words" array.
    5. WORDS: The "words" array must contain EVERY single word from that line with its own precise start/end time.
    6. WORD TIMINGS: The startTime of a word MUST be greater than or equal to the startTime of the parent segment, and endTime must be less than or equal to the parent segment's endTime.
    7. FAST SPEECH HANDLING: Align every word's start/end exactly to its pronunciation.
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
    You are an expert AudioTranscription AI specialized in generating precise timed lyrics and subtitled conversations.
    
    TASK: Transcribe the ENTIRE audio file into JSON segments.
    MODE: ${mode.toUpperCase()} LEVEL.
    
    ${timingPolicy}
    
    ${segmentationPolicy}

    LANGUAGE HANDLING (CRITICAL):
    1. RAPID CODE-SWITCHING: Audio often contains multiple languages mixed within the SAME sentence.
    2. MULTI-LINGUAL EQUALITY: Treat all detected languages as equally probable.
    3. NATIVE SCRIPT STRICTNESS: Write EACH word in its native script.
    4. MIXED SCRIPT PRESERVATION: Maintain mixed text (Kanji/Kana + Latin) exactly as spoken.
    
    GENERAL RULES (CRITICAL FOR GEMINI 2.5):
    - VERBATIM COMPLETENESS: Transcribe EXACTLY what is heard. DO NOT summarize, DO NOT skip any verses.
    - ENTIRE DURATION: You MUST process the audio from the very first second to the absolute end of the file. No truncating. ${durationHint}
    - Include fillers (um, ah) if they are prominently sung or spoken.
    - JSON Only: Output pure JSON without markdown fences or additional commentary.

    EXAMPLE EXPECTED FORMAT (IN SECONDS):
    {
      "segments": [
        {
          "startTime": 0.000,
          "endTime": 2.500,
          "text": "You will rejoice",
          ${mode === 'word' ? `"words": [
            {"text": "You", "startTime": 0.100, "endTime": 0.400},
            {"text": "will", "startTime": 0.400, "endTime": 0.800},
            {"text": "rejoice", "startTime": 0.800, "endTime": 1.500}
          ]` : ''}
        }
      ]
    }
  `;

  const requestConfig: any = {
    systemInstruction: systemInstructions,
    responseMimeType: "application/json",
    responseSchema: mode === 'word' ? WORD_LEVEL_SCHEMA : TRANSCRIPTION_SCHEMA,
    temperature: 0.1,
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ]
  };

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
              text: `Please transcribe this entire audio accurately following your system instructions. ${durationHint}`,
            }
          ],
        },
      ],
      config: requestConfig,
    });

    let text = response.text || "";
    
    // Cleanup Markdown if present
    text = text.trim();
    if (text.startsWith('```json')) {
      text = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (text.startsWith('```')) {
      text = text.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    const rawData = tryRepairJson(text);

    if (!rawData.segments || !Array.isArray(rawData.segments)) {
      throw new Error("Invalid transcription format received.");
    }

    let lastSegStart = 0;
    return rawData.segments.map((seg: any) => {
        let start = parseTimeToSeconds(seg.startTime);
        let end = parseTimeToSeconds(seg.endTime);
        
        // Clamp to duration
        if (duration) {
            if (start > duration) start = duration;
            if (end > duration) end = duration;
        }

        if (start < lastSegStart) {
            start = lastSegStart;
        }
        if (end <= start) {
            end = start + 0.1;
        }
        lastSegStart = start;
        
        const segment: SubtitleSegment = {
            start: start,
            end: end,
            text: seg.text,
            words: []
        };

        if (seg.words && Array.isArray(seg.words)) {
           let currentWordTime = start;
           segment.words = seg.words.map((w: any) => {
             let wStart = parseTimeToSeconds(w.startTime);
             let wEnd = parseTimeToSeconds(w.endTime);
             
             // Clamp to segment boundaries
             if (wStart < segment.start) wStart = segment.start;
             if (wEnd > segment.end) wEnd = segment.end;

             if (wStart < currentWordTime) {
                 wStart = currentWordTime;
             }
             if (wEnd <= wStart) {
                 wEnd = wStart + 0.1;
             }
             currentWordTime = wEnd;
             
             return {
                 start: wStart,
                 end: wEnd,
                 text: w.text
             };
           });
           
           if (segment.words.length > 0) {
               const firstWordStart = segment.words[0].start;
               const lastWordEnd = segment.words[segment.words.length - 1].end;
               if (firstWordStart < segment.start) {
                   segment.start = firstWordStart;
               }
               if (lastWordEnd > segment.end) {
                   segment.end = lastWordEnd;
               }
           }
        }

        return segment;
    });

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
