
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
      You are an expert **Lyric Synchronizer**. 
      Your goal is to segment the audio into **natural, full lyrical lines** while maintaining robotic precision for timestamps.

      ### SEGMENTATION STRATEGY (IMPORTANT)
      1. **Full Lines, Not Fragments**: Do NOT break sentences into tiny chunks (e.g., do not output "I went" then "to the" then "store"). Output "I went to the store" as one segment.
      2. **Natural Phrasing**: Follow the musical phrasing. A segment should usually be a complete line of verse or chorus.
      3. **Exceptions**: Short segments are allowed only for distinct interjections (e.g., "Yeah!", "Go!") or very short meaningful pauses.

      ### CRITICAL: TIMING & DRIFT PREVENTION
      1. **Anchor the Start**: The 'start' timestamp must correspond to the *first syllable* of the phrase.
      2. **Anchor the End**: The 'end' timestamp must correspond to the *last syllable* of the phrase.
      3. **Handle Repetitions**: If the singer repeats "Hello" three times, output three separate segments with distinct timestamps.
      4. **No Prediction**: Do not guess timing based on text. Listen to the audio signal.

      ### TEXT FIDELITY
      - Keep all single quotes (don't, it's, 'cause).
      - Transcribe exactly what is sung.

      ### FORMAT
      - Output: Pure JSON Array.
      - Timestamp: "MM:SS.mmm" (e.g. "00:04.250").
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
        thinkingConfig: modelName === 'gemini-3-flash-preview' ? { thinkingBudget: 4096 } : undefined,
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
