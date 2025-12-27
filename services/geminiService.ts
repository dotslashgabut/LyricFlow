
import { GoogleGenAI, Type } from "@google/genai";
import { SubtitleSegment, GeminiModel } from "../types";

export const transcribeAudio = async (
  base64Audio: string,
  mimeType: string,
  modelName: GeminiModel
): Promise<SubtitleSegment[]> => {
  if (!process.env.API_KEY) {
    throw new Error("API Key is missing. Please check your environment configuration.");
  }

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  // Base prompt for standard models
  let prompt = `
    Act as a professional audio transcriber and lyric synchronizer. 
    Analyze the provided audio and generate highly accurate subtitles/lyrics.

    TIMESTAMP PRECISION RULES:
    1. **FORMAT**: Timestamps MUST be strings in "MM:SS.mmm" format (e.g., "00:04.250").
    2. **SYNC**: The "start" timestamp must align exactly with the very first audible syllable.
    3. **DURATION**: The "end" timestamp must mark exactly when the phrase concludes.
    
    OUTPUT: Return a JSON array of objects with keys: "start", "end", "text".
  `;

  // Specialized Anti-Drift Prompt for Gemini 3 Flash
  if (modelName === 'gemini-3-flash-preview') {
    prompt = `
      You are an AI specialized in **Physical Audio Onset Detection**. 
      Your task is to generate a chronological log of vocal events from the provided audio.

      ### CRITICAL: QUOTES & TEXT ACCURACY
      - **Handle Single Quotes**: Words like "don't", "can't", "it's", " 'cause " MUST be transcribed verbatim.
      - **No Skipping**: Do NOT omit lines because of special characters or quotes.
      - **Valid JSON**: Ensure your JSON output escapes characters correctly if needed (e.g., "text": "It's time").

      ### THE "SAME-PREFIX" TIMING RULE (CRITICAL)
      If multiple lines start with the same words (e.g., a repeated chorus), you MUST NOT predict the timing. 
      - **DO NOT** assume the next line starts right after the previous one.
      - **DO NOT** skip forward based on textual similarity.
      - **ACTION**: You must find the EXACT millisecond where the vocal signal physically begins for EVERY instance.

      ### SYNC PROTOCOL
      1. **START ANCHOR**: The 'start' timestamp MUST be the absolute first millisecond of the vocal "attack".
      2. **END ANCHOR**: The 'end' timestamp MUST be the exact moment the vocal decay finishes.
      3. **ZERO PREDICTION**: Ignore any internal knowledge of song patterns. Treat every second of audio as a raw signal.

      ### FORMAT REQUIREMENTS
      - Output: Pure JSON Array of objects.
      - Precision: Use "MM:SS.mmm" (e.g., "01:23.456"). Milliseconds are MANDATORY.
    `;
  }

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Audio
            }
          },
          { text: prompt }
        ]
      },
      config: {
        // Disabled thinking budget to minimize creative/hallucinatory reasoning as requested.
        thinkingConfig: modelName === 'gemini-3-flash-preview' ? { thinkingBudget: 0 } : undefined,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              start: { 
                type: Type.STRING, 
                description: "Start time in 'MM:SS.mmm' format (ensure 3 decimal places)" 
              },
              end: { 
                type: Type.STRING, 
                description: "End time in 'MM:SS.mmm' format (ensure 3 decimal places)" 
              },
              text: { 
                type: Type.STRING, 
                description: "Verbatim transcribed text, preserving all quotes and punctuation" 
              }
            },
            required: ["start", "end", "text"]
          }
        }
      }
    });

    let jsonText = response.text || "";
    jsonText = jsonText.replace(/```json|```/g, "").trim();

    if (!jsonText) throw new Error("AI returned an empty response.");

    const rawSegments = JSON.parse(jsonText) as any[];

    // Advanced timestamp parsing to ensure sub-second precision is maintained
    const parseTimestamp = (ts: string | number): number => {
      if (typeof ts === 'number') return ts;
      if (!ts || typeof ts !== 'string') return 0;
      
      // CRITICAL FIX: Replace comma with dot to ensure parseFloat handles milliseconds correctly
      // Some locales or AI outputs might use "00:04,250" which JS parseFloat parses as 4.
      const cleanTs = ts.trim().replace(',', '.');
      const parts = cleanTs.split(':');
      
      try {
        if (parts.length === 2) {
          // Format MM:SS.mmm
          const minutes = parseFloat(parts[0]);
          const seconds = parseFloat(parts[1]);
          return (minutes * 60) + seconds;
        } else if (parts.length === 3) {
          // Format HH:MM:SS.mmm
          const hours = parseFloat(parts[0]);
          const minutes = parseFloat(parts[1]);
          const seconds = parseFloat(parts[2]);
          return (hours * 3600) + (minutes * 60) + seconds;
        } else {
          // Raw seconds or fallback
          const val = parseFloat(cleanTs);
          return isNaN(val) ? 0 : val;
        }
      } catch (e) {
        console.warn("Could not parse timestamp:", ts);
        return 0;
      }
    };

    // Post-process segments to ensure strict chronological order and remove potential empty artifacts
    return rawSegments
      .map(seg => ({
        start: parseTimestamp(seg.start),
        end: parseTimestamp(seg.end),
        text: (seg.text || "").trim()
      }))
      .filter(seg => seg.text.length > 0)
      .sort((a, b) => a.start - b.start);

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
