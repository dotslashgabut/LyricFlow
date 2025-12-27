
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

  // 1. Define strict System Instructions to govern model behavior
  // This helps prevent the model from getting "lazy" with repetitions.
  const systemInstruction = `
    You are a professional Lyric Alignment AI. Your specific goal is **Verbatim Transcription**.
    
    ### CRITICAL RULES FOR REPETITION & FLOW:
    1. **NEVER SUMMARIZE**: Do not use notation like "(x4)", "[chorus repeats]", or "[instrumental]". 
    2. **CAPTURE EVERY UTTERANCE**: If a singer repeats "eh eh eh" or "no no no" 10 times, you MUST include all 10 instances in the text.
    3. **NON-LEXICAL SOUNDS**: You must transcribe vocalizations like "ooh", "aah", "na na", "la la" exactly as they are sung.
    4. **CONTINUITY**: Do not stop transcribing until the audio is completely finished. Do not drop the last verse.
    5. **TIMESTAMP ACCURACY**: Ensure strictly increasing timestamps. 'end' time must never be before 'start' time.
  `;

  // 2. Specialized Prompting based on Model capabilities
  let prompt = "";

  if (modelName === 'gemini-3-flash-preview') {
    // Gemini 3 Flash Prompt (Logic Heavy)
    prompt = `
      Analyze the provided audio and generate a JSON array of subtitle segments.

      ### INSTRUCTIONS:
      1. **Granularity**: Break segments by natural musical phrasing (2 - 6 segments),
      2  **Content Accuracy**:
         - Even when grouping, you MUST transcribe every single instance of the repetition. 
         - Audio: "No no no no no" -> Segment Text: "No no no no no" (Correct).
         - Audio: "No no no no no" -> Segment Text: "No" (Incorrect).
      3. **Handling Repetition**: 
         The audio may contain highly repetitive sections (e.g., "eh eh eh", "baby baby baby"). 
         - **Do not merge these.** 
         - **Do not skip them.**
         - **Do not stop early.**
      4. **Precision**: Align 'start' to the first consonant/vowel of the phrase.

      ### OUTPUT FORMAT:
      Return ONLY a JSON Array.
      Timestamp format: "MM:SS.mmm" (e.g. "01:23.450").
    `;
  } else {
    // Gemini 2.5 Flash Prompt (Instruction Heavy for Stability)
    prompt = `
      Act as a strict verbatim transcriber. Listen to the audio file and transcribe the lyrics/speech into timed segments.

      ### SEGMENTATION STRATEGY:
      1. **Group Repetitions**: When the audio contains rapid repetitive sounds (e.g., "eh eh eh eh eh"), **keep them in a single segment** (e.g. text: "eh eh eh eh eh"). Do NOT split them into individual one-word lines.
      2. **Natural Phrasing**: Create segments that correspond to full musical phrases (usually 3-10 words).
      
      ### CONTENT ACCURACY:
      - Even when grouping, you MUST transcribe every single instance of the repetition. 
      - Audio: "No no no no no" -> Segment Text: "No no no no no" (Correct).
      - Audio: "No no no no no" -> Segment Text: "No" (Incorrect).

      ### FORMATTING:
      - Return a JSON array of objects.
      - Properties: "start", "end", "text".
      - "start" and "end" must be strings in "MM:SS.mmm" format (e.g. "01:23.450").
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
        systemInstruction: systemInstruction,
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
                description: "Verbatim text. DO NOT summarize repetitions." 
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
