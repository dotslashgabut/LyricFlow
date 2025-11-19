# LyricFlow - AI Subtitle & Lyric Generator

LyricFlow is a modern web application that uses Google's **Gemini 2.5 Flash** model to convert audio files and voice recordings into perfectly timed subtitles (`.srt`) and lyrics (`.lrc`). 

It features a high-precision audio player with synchronized text highlighting, allowing you to review and download your transcriptions instantly.

[**Open App in AI Studio**](https://ai.studio/apps/drive/1M1VfxdBlNB_eOPQqQiHspvVwizaEs0aI?showPreview=true&fullscreenApplet=true&showAssistant=true)

## ✨ Features

*   **Dual Input Modes**: 
    *   **File Upload**: Supports MP3, WAV, M4A, OGG, FLAC (up to 12MB).
    *   **Microphone**: Real-time in-browser recording with audio visualization.
*   **AI-Powered Precision**: 
    *   Uses `gemini-2.5-flash` for high-speed, accurate transcription.
    *   Strict `MM:SS.mmm` timing enforcement to ensure timestamp accuracy.
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

## 💻 Run Locally

1. **Prerequisites**: [Node.js](https://nodejs.org/)
2. **Clone this repository**
   Clone or download this repository
   ```bash
   git clone https://github.com/dotslashgabut/lyricflow.git
   ```
   ```bash
   cd lyricflow
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Set the API Key**:
   Create or edit a `.env.local` file in the root directory and set `API_KEY` to your Gemini API key:
   ```env
   API_KEY=PLACEHOLDER_API_KEY
   ```
5. **Run the app**:
   ```bash
   npm run dev
   ```

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

## 🔧 Configuration

This application requires a valid Google Gemini API Key.

1.  The app expects `process.env.API_KEY` to be available.
2.  The AI model used is `gemini-2.5-flash`.

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