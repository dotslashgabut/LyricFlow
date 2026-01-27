
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Upload, FileAudio, X, Loader2, ArrowRight, Wand2, Maximize, Minimize, Cpu, AlignJustify, ScanText, Video } from 'lucide-react';
import { AppState, SubtitleSegment, AudioSource, GeminiModel, TranscriptionMode } from './types';
import { transcribeAudio, fileToBase64 } from './services/geminiService';
import AudioVisualizer from './components/AudioVisualizer';
import ResultsView from './components/ResultsView';
import { formatDuration } from './utils/timeUtils';

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [audioSourceType, setAudioSourceType] = useState<AudioSource>('upload');
  const [selectedModel, setSelectedModel] = useState<GeminiModel>('gemini-2.5-flash');
  const [transcriptionMode, setTranscriptionMode] = useState<TranscriptionMode>('line');
  const [audioFile, setAudioFile] = useState<Blob | null>(null);
  const [audioName, setAudioName] = useState<string>('');
  const [transcription, setTranscription] = useState<SubtitleSegment[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Use a counter to track the current transcription request ID. 
  // This allows us to ignore results from cancelled requests (logic-level abort).
  const transcriptionRequestIdRef = useRef<number>(0);

  // --- Fullscreen Logic ---
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.error(`Error enabling fullscreen mode: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  // --- File Processing Helper ---
  const processFile = (file: File) => {
    if (file.size > 25 * 1024 * 1024) { // Increased to 25MB for video support
      setErrorMsg("File is too large. Please choose a file under 25MB.");
      return;
    }
    
    // Support audio and video files
    const isAudio = file.type.startsWith('audio/') || file.name.match(/\.(mp3|wav|m4a|ogg|flac)$/i);
    const isVideo = file.type.startsWith('video/') || file.name.match(/\.(mp4|webm|mov|avi|mkv)$/i);

    if (!isAudio && !isVideo) {
       setErrorMsg("Unsupported file format. Please upload an audio or video file.");
       return;
    }

    setAudioFile(file);
    setAudioName(file.name);
    setAppState(AppState.READY);
    setErrorMsg(null);
  };

  // --- File Upload Handlers ---
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const clearFile = () => {
    setAudioFile(null);
    setAudioName('');
    setAppState(AppState.IDLE);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // --- Drag and Drop Handlers ---
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      processFile(files[0]);
    }
  };

  // --- Recording Handlers ---
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setAudioFile(blob);
        setAudioName(`recording_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.webm`);
        setAppState(AppState.READY);
        
        // Stop all tracks
        stream.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      };

      mediaRecorder.start();
      setIsRecording(true);
      setAppState(AppState.RECORDING);
      setErrorMsg(null);

      // Timer
      setRecordingDuration(0);
      timerRef.current = window.setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);

    } catch (err) {
      console.error("Error accessing microphone:", err);
      setErrorMsg("Could not access microphone. Please ensure permissions are granted.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  const cancelRecording = () => {
    stopRecording();
    setAppState(AppState.IDLE);
    setAudioFile(null);
  };

  // --- Transcription Handler ---
  const handleTranscribe = async () => {
    if (!audioFile) return;

    // Increment Request ID to invalidate any previous pending requests
    const currentRequestId = transcriptionRequestIdRef.current + 1;
    transcriptionRequestIdRef.current = currentRequestId;

    setAppState(AppState.PROCESSING);
    setErrorMsg(null);

    try {
      const base64 = await fileToBase64(audioFile);
      
      // Check cancellation after file read
      if (transcriptionRequestIdRef.current !== currentRequestId) return;

      const mimeType = audioFile.type || 'audio/mp3'; // Default fallback if type missing
      
      const segments = await transcribeAudio(base64, mimeType, selectedModel, transcriptionMode);
      
      // Check cancellation after API call
      if (transcriptionRequestIdRef.current !== currentRequestId) return;

      setTranscription(segments);
      setAppState(AppState.COMPLETED);
    } catch (err) {
      // Check cancellation before showing error
      if (transcriptionRequestIdRef.current !== currentRequestId) return;

      console.error(err);
      setErrorMsg("Failed to transcribe audio. Please try again or check your API Key.");
      setAppState(AppState.READY); // Go back to ready state to retry
    }
  };

  const handleCancelTranscription = () => {
    // Increment Request ID to invalidate the running request
    transcriptionRequestIdRef.current += 1;
    setAppState(AppState.READY);
    setErrorMsg(null);
  };

  const handleReset = () => {
    setAppState(AppState.IDLE);
    setAudioFile(null);
    setAudioName('');
    setTranscription([]);
    setErrorMsg(null);
  };

  const isVideoFileSelected = audioFile?.type.startsWith('video/') || audioName.match(/\.(mp4|webm|mov|avi|mkv)$/i);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-950 text-slate-200 flex flex-col">
      {/* Navbar */}
      <header className="w-full p-6 border-b border-slate-800/50 backdrop-blur-sm fixed top-0 z-50">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600 rounded-lg">
              <Wand2 className="text-white w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white">LyricFlow</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden sm:block text-xs font-medium px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              Powered by {selectedModel === 'gemini-3-flash-preview' ? 'Gemini 3 Flash' : 'Gemini 2.5 Flash'}
            </div>
            <button 
              onClick={toggleFullscreen}
              className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
              title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
            >
              {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 mt-20 w-full max-w-6xl mx-auto">
        
        {/* ERROR ALERT */}
        {errorMsg && (
          <div className="w-full max-w-md mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-200 text-sm text-center animate-fade-in">
            {errorMsg}
          </div>
        )}

        {/* VIEW: RESULTS */}
        {appState === AppState.COMPLETED ? (
          <ResultsView 
            segments={transcription} 
            onReset={handleReset} 
            audioName={audioName} 
            audioFile={audioFile}
            selectedModel={selectedModel}
            setSelectedModel={setSelectedModel}
            onRetry={handleTranscribe}
            transcriptionMode={transcriptionMode}
            setTranscriptionMode={setTranscriptionMode}
          />
        ) : (
          /* VIEW: INPUT / PROCESSING */
          <div className="w-full max-w-2xl animate-fade-in-up">
            
            {/* Hero Text */}
            <div className="text-center mb-10">
              <h2 className="text-4xl font-extrabold text-white mb-4 tracking-tight">
                Turn Media into <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400">Subtitles</span>
              </h2>
              <p className="text-slate-400 text-lg max-w-lg mx-auto">
                Generate perfectly timed SRT, LRC, or VTT files. <span className="text-indigo-400">Supports Audio & Video Files</span> (MP4, MP3, WAV, etc).
              </p>
            </div>

            {/* Input Card */}
            <div className="bg-slate-800 rounded-2xl shadow-2xl border border-slate-700 p-1 overflow-hidden relative">
              
              {/* Loading Overlay */}
              {appState === AppState.PROCESSING && (
                <div className="absolute inset-0 z-50 bg-slate-900/80 backdrop-blur-sm flex flex-col items-center justify-center text-center p-8">
                  <Loader2 className="w-12 h-12 text-indigo-500 animate-spin mb-4" />
                  <h3 className="text-xl font-bold text-white">Transcribing Media...</h3>
                  <p className="text-slate-400 mt-2">Processing with {selectedModel === 'gemini-3-flash-preview' ? 'Gemini 3 Flash' : 'Gemini 2.5 Flash'}</p>
                  <p className="text-indigo-400/80 text-xs font-medium mt-2 animate-pulse">Extracting dialogue & synchronizing...</p>
                  <p className="text-slate-500 text-xs mt-1">Mode: {transcriptionMode === 'line' ? 'Lines/Sentences' : 'Word-by-Word'}</p>
                  
                  <button 
                    onClick={handleCancelTranscription}
                    className="mt-8 px-5 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 rounded-full text-xs font-bold transition-all flex items-center gap-2 group"
                  >
                    <X size={14} className="group-hover:scale-110 transition-transform"/> Stop Processing
                  </button>
                </div>
              )}

              {/* Configuration Toggles */}
              {appState !== AppState.PROCESSING && (
                <div className="px-4 pt-4 space-y-4">
                  {/* Model Selector */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1 flex items-center gap-1.5">
                        <Cpu size={12} /> Select AI Engine
                      </label>
                      <div className="grid grid-cols-2 gap-2 p-1 bg-slate-900/50 rounded-xl border border-slate-700/50">
                        <button
                          onClick={() => setSelectedModel('gemini-2.5-flash')}
                          className={`py-2 text-xs font-bold rounded-lg transition-all flex flex-col items-center justify-center ${
                            selectedModel === 'gemini-2.5-flash' 
                              ? 'bg-indigo-600 text-white shadow-lg' 
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Gemini 2.5
                          <span className="text-[8px] opacity-60 font-medium">Standard</span>
                        </button>
                        <button
                          onClick={() => setSelectedModel('gemini-3-flash-preview')}
                          className={`py-2 text-xs font-bold rounded-lg transition-all flex flex-col items-center justify-center ${
                            selectedModel === 'gemini-3-flash-preview' 
                              ? 'bg-indigo-600 text-white shadow-lg' 
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Gemini 3
                          <span className="text-[8px] opacity-60 font-medium">Fastest</span>
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1 flex items-center gap-1.5">
                        <ScanText size={12} /> Granularity
                      </label>
                      <div className="grid grid-cols-2 gap-2 p-1 bg-slate-900/50 rounded-xl border border-slate-700/50">
                        <button
                          onClick={() => setTranscriptionMode('line')}
                          className={`py-2 text-xs font-bold rounded-lg transition-all flex flex-col items-center justify-center gap-0.5 ${
                            transcriptionMode === 'line' 
                              ? 'bg-indigo-600 text-white shadow-lg' 
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                           <div className="flex items-center gap-1"><AlignJustify size={10} /> Lines</div>
                          <span className="text-[8px] opacity-60 font-medium">Standard SRT/LRC</span>
                        </button>
                        <button
                          onClick={() => setTranscriptionMode('word')}
                          className={`py-2 text-xs font-bold rounded-lg transition-all flex flex-col items-center justify-center gap-0.5 ${
                            transcriptionMode === 'word' 
                              ? 'bg-indigo-600 text-white shadow-lg' 
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <div className="flex items-center gap-1"><ScanText size={10} /> Words</div>
                          <span className="text-[8px] opacity-60 font-medium">For VTT / Karaoke</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Input Source Selector */}
                  <div className="grid grid-cols-2 gap-2 p-1 bg-slate-900/50 rounded-xl border border-slate-700/50">
                    <button
                      onClick={() => !isRecording && setAudioSourceType('upload')}
                      disabled={appState === AppState.RECORDING}
                      className={`py-2 text-xs font-bold rounded-lg transition-all ${
                        audioSourceType === 'upload' 
                          ? 'bg-slate-700 text-white shadow-sm' 
                          : 'text-slate-400 hover:text-slate-200'
                      } ${appState === AppState.RECORDING ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      Upload File
                    </button>
                    <button
                      onClick={() => !audioFile && setAudioSourceType('microphone')}
                      disabled={appState === AppState.READY && audioSourceType === 'upload'}
                      className={`py-2 text-xs font-bold rounded-lg transition-all ${
                        audioSourceType === 'microphone' 
                          ? 'bg-slate-700 text-white shadow-sm' 
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Record Audio
                    </button>
                  </div>
                </div>
              )}

              {/* Content Area */}
              <div className="px-6 pb-8 pt-4 min-h-[200px] flex flex-col justify-center">
                
                {/* MODE: UPLOAD */}
                {audioSourceType === 'upload' && (
                  <div className="flex flex-col items-center">
                    {!audioFile ? (
                      <label 
                        onDragEnter={handleDragEnter}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        className={`w-full border-2 border-dashed transition-all rounded-xl p-10 cursor-pointer group flex flex-col items-center justify-center text-center ${
                          isDragging 
                            ? 'border-indigo-400 bg-indigo-500/10 scale-[1.02]' 
                            : 'border-slate-600 hover:border-indigo-500 hover:bg-slate-800/50'
                        }`}
                      >
                        <div className={`p-4 rounded-full mb-4 transition-transform ${isDragging ? 'bg-indigo-500 scale-110' : 'bg-slate-700 group-hover:scale-110'}`}>
                          <Upload className={`w-8 h-8 ${isDragging ? 'text-white' : 'text-indigo-400'}`} />
                        </div>
                        <p className="text-lg font-medium text-slate-200">
                          {isDragging ? 'Drop file here' : 'Click to upload or drag and drop'}
                        </p>
                        <p className="text-sm text-slate-500 mt-2">Audio/Video (MP4, MP3, etc. Max 25MB)</p>
                        <input 
                          ref={fileInputRef}
                          type="file" 
                          accept=".mp3,.wav,.m4a,.ogg,.flac,audio/*,video/*,.mp4,.webm,.mov"
                          className="hidden" 
                          onChange={handleFileChange}
                        />
                      </label>
                    ) : (
                      <div className="w-full">
                        <div className="bg-slate-900/80 rounded-xl p-4 flex items-center justify-between border border-slate-700">
                          <div className="flex items-center gap-4 overflow-hidden">
                            <div className="p-3 bg-indigo-500/20 rounded-lg">
                              {isVideoFileSelected ? <Video className="w-6 h-6 text-indigo-400" /> : <FileAudio className="w-6 h-6 text-indigo-400" />}
                            </div>
                            <div className="truncate">
                              <p className="font-medium text-white truncate">{audioName}</p>
                              <p className="text-xs text-slate-400">Source: {isVideoFileSelected ? 'Video' : 'Audio'}</p>
                            </div>
                          </div>
                          <button 
                            onClick={clearFile}
                            className="p-2 hover:bg-slate-700 rounded-full text-slate-400 hover:text-white transition-colors"
                          >
                            <X size={18} />
                          </button>
                        </div>
                        <button 
                          onClick={handleTranscribe}
                          className="w-full mt-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-xl shadow-lg shadow-indigo-500/25 transition-all flex items-center justify-center gap-2"
                        >
                          Generate Subtitles
                          <ArrowRight size={18} />
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* MODE: MICROPHONE */}
                {audioSourceType === 'microphone' && (
                  <div className="flex flex-col items-center w-full">
                    {!audioFile ? (
                      <div className="flex flex-col items-center w-full">
                         {isRecording ? (
                            <div className="w-full flex flex-col items-center">
                              <div className="text-5xl font-mono font-bold text-white mb-6 tabular-nums">
                                {formatDuration(recordingDuration)}
                              </div>
                              <AudioVisualizer stream={streamRef.current} isRecording={isRecording} />
                              <div className="flex gap-4 mt-8">
                                <button 
                                  onClick={cancelRecording}
                                  className="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-full font-medium transition-colors"
                                >
                                  Cancel
                                </button>
                                <button 
                                  onClick={stopRecording}
                                  className="px-6 py-2 bg-red-500 hover:bg-red-600 text-white rounded-full font-medium shadow-lg shadow-red-500/25 animate-pulse-slow transition-colors"
                                >
                                  Stop Recording
                                </button>
                              </div>
                            </div>
                         ) : (
                            <button 
                              onClick={startRecording}
                              className="group relative flex flex-col items-center justify-center"
                            >
                              <div className="w-20 h-20 rounded-full bg-red-500 flex items-center justify-center shadow-xl shadow-red-500/20 group-hover:scale-110 transition-transform duration-300">
                                <Mic className="w-8 h-8 text-white" />
                              </div>
                              <p className="mt-6 text-lg font-medium text-slate-200">Tap to Record</p>
                            </button>
                         )}
                      </div>
                    ) : (
                      <div className="w-full">
                        <div className="bg-slate-900/80 rounded-xl p-4 flex items-center justify-between border border-slate-700">
                          <div className="flex items-center gap-4">
                             <div className="p-3 bg-red-500/20 rounded-lg">
                              <Mic className="w-6 h-6 text-red-400" />
                            </div>
                            <div>
                              <p className="font-medium text-white">Voice Recording</p>
                              <p className="text-xs text-slate-400">{audioName}</p>
                            </div>
                          </div>
                           <button 
                            onClick={cancelRecording}
                            className="p-2 hover:bg-slate-700 rounded-full text-slate-400 hover:text-white transition-colors"
                          >
                            <X size={18} />
                          </button>
                        </div>
                        <button 
                          onClick={handleTranscribe}
                          className="w-full mt-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-xl shadow-lg shadow-indigo-500/25 transition-all flex items-center justify-center gap-2"
                        >
                          Generate Subtitles
                          <ArrowRight size={18} />
                        </button>
                      </div>
                    )}
                  </div>
                )}

              </div>
            </div>
            
            {/* Footer info */}
            <p className="text-center text-slate-500 text-sm mt-6">
              Private & Secure. Processed via Google Gemini AI.
            </p>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
