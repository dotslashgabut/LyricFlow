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
    Listen to the provided audio carefully. 
    Extract the lyrics or spoken text along with precise timestamps.
    Split the text into natural phrasing segments suitable for subtitles.
    For music, sync with the vocal melody.
    
    CRITICAL INSTRUCTION FOR TIMESTAMPS:
    1. Use **ABSOLUTE TOTAL SECONDS** from the start of the file.
    2. **HIGH PRECISION REQUIRED**: 
       - Provide timestamps with 3 decimal places (e.g., 12.345).
       - **DO NOT** round to the nearest quarter-second (0.25, 0.50). 
       - Timestamps must match the exact audio event start.
    3. **NO RESET**: Do not reset the timer at 60 seconds. 
       - Correct: 65.5 seconds (for 1m 5.5s)
       - Incorrect: 1.055 or 05.5
    4. DO NOT use "MM.SS" format. Always convert minutes to seconds.
       - Example: 1 minute 30 seconds = 90.0
    5. Timestamps must be strictly increasing.
    
    Return a JSON array where each item contains:
    - start: start time in seconds (number)
    - end: end time in seconds (number)
    - text: the text content (string)
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
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              start: { type: Type.NUMBER },
              end: { type: Type.NUMBER },
              text: { type: Type.STRING }
            },
            required: ["start", "end", "text"]
          }
        }
      }
    });

    let jsonText = response.text || "";
    
    // Clean potential markdown code blocks
    jsonText = jsonText.replace(/```json|```/g, "").trim();

    if (!jsonText) {
      throw new Error("No response text generated.");
    }

    const rawSegments = JSON.parse(jsonText) as SubtitleSegment[];

    // Post-processing to fix potential timestamp resets or MM.SS format issues
    let offset = 0;
    let lastStart = -1;

    const segments = rawSegments.map(seg => {
      // Safety conversion
      let currentStart = Number(seg.start);
      let currentEnd = Number(seg.end);

      // Detection Logic:
      // If the current timestamp is significantly smaller than the last one (by > 10s),
      // it likely means the model reset the clock (modulo 60 error).
      if (lastStart !== -1 && (currentStart + offset) < (lastStart - 5)) {
        // If the drop is severe, assume a 60s reset occurred.
        while ((currentStart + offset) < (lastStart - 5)) {
          offset += 60;
        }
      }

      const finalStart = currentStart + offset;
      const finalEnd = currentEnd + offset;
      
      lastStart = finalStart;

      return {
        ...seg,
        start: finalStart,
        end: finalEnd
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
      // Remove the "data:audio/xxx;base64," prefix
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
  });
};