# LyricFlow - AI Subtitle & Lyric Generator

LyricFlow is a modern web application that uses Google's **Gemini 2.5 Flash** model to convert audio files and voice recordings into perfectly timed subtitles (`.srt`) and lyrics (`.lrc`). 

It features a high-precision audio player with synchronized text highlighting, allowing you to review and download your transcriptions instantly.

[**Open App in AI Studio**](https://ai.studio/apps/drive/1M1VfxdBlNB_eOPQqQiHspvVwizaEs0aI?showPreview=true&fullscreenApplet=true&showAssistant=true)

## ✨ Features

*   **Dual Input Modes**: 
    *   **File Upload**: Supports MP3, WAV, M4A, OGG, FLAC (up to 15MB).
    *   **Microphone**: Real-time in-browser recording with audio visualization.
*   **AI-Powered Precision**: 
    *   Uses `gemini-2.5-flash` for high-speed, accurate transcription.
    *   **Thinking Config** enabled to reduce hallucinations and ensure mathematical accuracy in timestamps.
    *   Strict `MM:SS.mmm` timing enforcement.
*   **Interactive Results View**:
    *   **Synchronized Playback**: Text highlights in real-time as audio plays.
    *   **Click-to-Seek**: Click any subtitle line to jump audio to that exact timestamp.
    *   **Auto-Scroll**: The view automatically follows the active line.
*   **Export Formats**:
    *   **SRT** (SubRip Subtitle): Standard format for video players (YouTube, VLC).
    *   **LRC** (Lyric File): Standard format for music players (Karaoke, Spotify-style).

## 🛠️ Tech Stack

*   **Frontend**: React 19, TypeScript
*   **Styling**: Tailwind CSS (Dark Mode)
*   **AI Integration**: Google Gen AI SDK (`@google/genai`)
*   **Icons**: Lucide React
*   **Tooling**: Vite-compatible structure

## 🚀 Usage

1.  **Select Input**:
    *   Upload an existing audio file.
    *   Or, record your voice directly in the browser.
2.  **Transcribe**:
    *   Click "Generate Subtitles".
    *   The app sends the audio to Gemini 2.5 Flash to analyze speech and timing.
3.  **Review & Export**:
    *   Play the audio to verify synchronization.
    *   Download the `.srt` or `.lrc` files to use with your media.

## 💻 Run Locally

To run this application on your local machine, you'll need [Node.js](https://nodejs.org/) (v18+) and [npm](https://www.npmjs.com/) installed.

1.  **Initialize a project**:
    ```bash
    npm create vite@latest lyricflow -- --template react-ts
    cd lyricflow
    ```

2.  **Install dependencies**:
    ```bash
    npm install @google/genai lucide-react
    # Optional: Install Tailwind CSS via npm if you prefer over CDN
    npm install -D tailwindcss postcss autoprefixer
    npx tailwindcss init -p
    ```

3.  **Copy Files**:
    Copy the provided source files (`App.tsx`, `types.ts`, etc.) into the `src/` folder of your new project.

4.  **Configure Environment**:
    Create a `.env` file in the root directory and add your API key:
    ```env
    API_KEY=your_actual_gemini_api_key_here
    ```

    *Note: You may need to update `vite.config.ts` to expose the `API_KEY` to `process.env` for the app to read it correctly:*
    ```ts
    // vite.config.ts
    import { defineConfig, loadEnv } from 'vite'
    import react from '@vitejs/plugin-react'

    export default defineConfig(({ mode }) => {
      const env = loadEnv(mode, process.cwd(), '');
      return {
        plugins: [react()],
        define: {
          'process.env.API_KEY': JSON.stringify(env.API_KEY)
        }
      }
    })
    ```

5.  **Start the App**:
    ```bash
    npm run dev
    ```

## 🔧 Configuration

This application requires a valid Google Gemini API Key.

1.  The app expects `process.env.API_KEY` to be available.
2.  The AI model used is `gemini-2.5-flash` with a configured `thinkingBudget` of 2048 tokens to ensure timestamp accuracy.

## 📝 Formats Supported

**SRT (SubRip)**
```text
1
00:00:28,106 --> 00:00:34,510
Lyrics line one...
```

**LRC (Lyrics)**
```text
[ti:Song Title]
[ar:Artist]
[00:28.11]Lyrics line one...
[00:34.51]Lyrics line two...
```

## ⚠️ Note on Accuracy

While Gemini 2.5 Flash is extremely capable, audio with heavy background noise or unclear vocals may impact transcription accuracy. The app includes post-processing logic to mitigate common LLM timestamp hallucinations.