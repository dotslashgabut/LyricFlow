import { GoogleGenAI, Type } from "@google/genai";
import { SubtitleSegment } from "../types";

const MODEL_NAME = "gemini-2.5-flash";

export const transcribeAudio = async (
  base64Audio: string,
  mimeType: string
): Promise<SubtitleSegment[]> => {
  if (!process.env.API_KEY) {
    throw new Error("API Key is missing. Please check your environment configuration.");
  }

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  const prompt = `
    Analyze the audio and generate subtitles/lyrics with high-precision timing.

    TIMESTAMPS RULES:
    1. **FORMAT**: You MUST return timestamps as STRINGS in "MM:SS.mmm" format (e.g., "00:00.500", "01:02.340").
    2. **PRECISION**: Use exactly 3 decimal places for milliseconds.
    3. **CONTINUITY**: 
       - Timestamps must be ABSOLUTE from the start of the file.
       - Minutes must increment correctly (e.g., "00:59.900" -> "01:00.100").
       - DO NOT reset the timer.
    4. **ACCURACY**: Sync exactly with the start of vocals or speech.
    
    OUTPUT FORMAT:
    Return a JSON array of objects. Each object must have:
    - "start": String ("MM:SS.mmm")
    - "end": String ("MM:SS.mmm")
    - "text": String
  `;

  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
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
        // Enable thinking to improve math/timing logic and prevent hallucinations
        thinkingConfig: { thinkingBudget: 2048 },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              start: { type: Type.STRING, description: "Start time 'MM:SS.mmm'" },
              end: { type: Type.STRING, description: "End time 'MM:SS.mmm'" },
              text: { type: Type.STRING }
            },
            required: ["start", "end", "text"]
          }
        }
      }
    });

    let jsonText = response.text || "";
    jsonText = jsonText.replace(/```json|```/g, "").trim();

    if (!jsonText) {
      throw new Error("No response text generated.");
    }

    const rawSegments = JSON.parse(jsonText) as any[];

    // Parse "MM:SS.mmm" strings into absolute seconds
    const parseTimestamp = (ts: string): number => {
      if (!ts || typeof ts !== 'string') return 0;
      
      const parts = ts.split(':');
      
      // Handle MM:SS.mmm
      if (parts.length === 2) {
        const minutes = parseFloat(parts[0]);
        const seconds = parseFloat(parts[1]);
        return (minutes * 60) + seconds;
      }
      
      // Handle HH:MM:SS.mmm (rare but possible)
      if (parts.length === 3) {
        const hours = parseFloat(parts[0]);
        const minutes = parseFloat(parts[1]);
        const seconds = parseFloat(parts[2]);
        return (hours * 3600) + (minutes * 60) + seconds;
      }

      return parseFloat(ts);
    };

    const segments = rawSegments.map(seg => {
      const start = parseTimestamp(seg.start);
      const end = parseTimestamp(seg.end);
      
      return {
        start: isNaN(start) ? 0 : start,
        end: isNaN(end) ? 0 : end,
        text: seg.text || ""
      };
    });

    return segments;

  } catch (error) {
    console.error("Transcription error:", error);
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
    reader.onerror = (error) => reject(error);
  });
};
