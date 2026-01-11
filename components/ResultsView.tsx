
import React, { useState, useEffect, useRef } from 'react';
import { SubtitleSegment, AspectRatio, GeminiModel } from '../types';
import { generateLRC, generateSRT, generateTTML, formatToDisplayTime } from '../utils/timeUtils';
import { 
  FileText, 
  Music, 
  Video, 
  Settings, 
  ChevronDown, 
  ChevronUp, 
  Loader2, 
  ArrowLeft,
  Layout,
  Type as TypeIcon,
  Monitor,
  Smartphone,
  Sparkles,
  Layers,
  Palette,
  RefreshCw,
  Code2
} from 'lucide-react';

interface ResultsViewProps {
  segments: SubtitleSegment[];
  onReset: () => void;
  audioName: string;
  audioFile: Blob | null;
  selectedModel: GeminiModel;
  setSelectedModel: (model: GeminiModel) => void;
  onRetry: () => void;
}

type Resolution = '720p' | '1080p';

const PRESET_COLORS = [
  { name: 'Midnight', hex: '#020617', secondary: '#1e1b4b' },
  { name: 'Deep Sea', hex: '#082f49', secondary: '#0c4a6e' },
  { name: 'Burgundy', hex: '#450a0a', secondary: '#7f1d1d' },
  { name: 'Emerald', hex: '#064e3b', secondary: '#065f46' },
  { name: 'Volcano', hex: '#431407', secondary: '#7c2d12' },
  { name: 'Obsidian', hex: '#18181b', secondary: '#27272a' },
];

const ResultsView: React.FC<ResultsViewProps> = ({ 
  segments, 
  onReset, 
  audioName, 
  audioFile,
  selectedModel,
  setSelectedModel,
  onRetry
}) => {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9');
  const [resolution, setResolution] = useState<Resolution>('1080p');
  const [bgColor, setBgColor] = useState(PRESET_COLORS[0].hex);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  
  const [metadata, setMetadata] = useState({
    title: '',
    artist: '',
    album: ''
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeSegRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const isAbortedRef = useRef<boolean>(false);

  useEffect(() => {
    const nameWithoutExt = audioName.replace(/\.[^/.]+$/, "");
    setMetadata(prev => ({ ...prev, title: nameWithoutExt }));
  }, [audioName]);

  useEffect(() => {
    if (audioFile) {
      const url = URL.createObjectURL(audioFile);
      setAudioUrl(url);
      return () => {
        URL.revokeObjectURL(url);
        if (audioContextRef.current) {
          audioContextRef.current.close().catch(() => {});
          audioContextRef.current = null;
        }
      };
    }
  }, [audioFile]);

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleSeek = (time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      audioRef.current.play();
    }
  };

  useEffect(() => {
    const index = segments.findIndex(s => currentTime >= s.start && currentTime <= s.end);
    if (index !== activeIndex) {
      setActiveIndex(index);
    }
  }, [currentTime, segments, activeIndex]);

  // Auto-scroll logic
  useEffect(() => {
    if (activeIndex !== -1 && activeSegRef.current && containerRef.current) {
      const container = containerRef.current;
      const element = activeSegRef.current;
      
      const elementTop = element.offsetTop;
      const containerHeight = container.clientHeight;
      const elementHeight = element.clientHeight;
      
      container.scrollTo({
        top: elementTop - containerHeight / 2 + elementHeight / 2,
        behavior: 'smooth'
      });
    }
  }, [activeIndex]);

  const downloadTextFile = (content: string, extension: string) => {
    const blob = new Blob([content], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const baseName = metadata.title.trim() || audioName.replace(/\.[^/.]+$/, "");
    const safeName = baseName.replace(/[^a-z0-9_\-\s]/gi, '').trim() || 'lyrics';
    a.download = `${safeName}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const abortExport = () => {
    isAbortedRef.current = true;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    setIsExporting(false);
    setExportProgress(0);
  };

  const exportVideo = async () => {
    if (!canvasRef.current || !audioRef.current) return;
    
    setIsExporting(true);
    setExportProgress(0);
    isAbortedRef.current = false;
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    const audio = audioRef.current;
    
    const isHD = resolution === '1080p';
    let baseW = isHD ? 1920 : 1280;
    let baseH = isHD ? 1080 : 720;
    let width = baseW;
    let height = baseH;

    if (aspectRatio === '9:16') {
      width = baseH; height = baseW;
    } else if (aspectRatio === '3:4') {
      width = isHD ? 1080 : 720; height = isHD ? 1440 : 960;
    }
    
    canvas.width = width;
    canvas.height = height;

    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const audioContext = audioContextRef.current;
    if (audioContext.state === 'suspended') await audioContext.resume();

    if (!sourceNodeRef.current) {
      sourceNodeRef.current = audioContext.createMediaElementSource(audio);
    }
    const source = sourceNodeRef.current;

    if (!analyserRef.current) {
      analyserRef.current = audioContext.createAnalyser();
      analyserRef.current.fftSize = 256;
    }
    const analyser = analyserRef.current;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    const dest = audioContext.createMediaStreamDestination();
    source.disconnect();
    analyser.disconnect();
    source.connect(analyser);
    analyser.connect(dest);
    analyser.connect(audioContext.destination);

    const canvasStream = canvas.captureStream(30);
    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks()
    ]);

    const mimeType = 'video/webm;codecs=vp9,opus';
    const mediaRecorder = new MediaRecorder(combinedStream, {
      mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : 'video/webm',
      videoBitsPerSecond: isHD ? 12000000 : 6000000
    });
    mediaRecorderRef.current = mediaRecorder;

    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      if (!isAbortedRef.current && chunks.length > 0) {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeName = metadata.title.trim().replace(/[^a-z0-9_\-\s]/gi, '') || 'video';
        a.download = `${safeName}.webm`;
        a.click();
        URL.revokeObjectURL(url);
      }
      setIsExporting(false);
      setExportProgress(0);
    };

    mediaRecorder.start();
    audio.currentTime = 0;
    audio.play();

    const selectedPreset = PRESET_COLORS.find(p => p.hex === bgColor);
    const secondaryColor = selectedPreset ? selectedPreset.secondary : '#000000';

    const drawFrame = () => {
      if (isAbortedRef.current) return;
      if (audio.paused || audio.ended) {
        if (mediaRecorder.state === 'recording') mediaRecorder.stop();
        return;
      }

      const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
      bgGrad.addColorStop(0, bgColor); 
      bgGrad.addColorStop(1, secondaryColor);
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      analyser.getByteFrequencyData(dataArray);
      const barCount = 64;
      const barWidth = (width / barCount);
      const visualizerHeight = height * 0.35;
      
      for (let i = 0; i < barCount; i++) {
        const segmentSize = Math.floor(bufferLength / barCount);
        let sum = 0;
        for (let j = 0; j < segmentSize; j++) sum += dataArray[i * segmentSize + j];
        const percent = (sum / segmentSize) / 255;
        const barH = percent * visualizerHeight;
        const x = i * barWidth;
        const y = height - barH;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.fillRect(x + 1, y, barWidth - 2, barH);
      }

      const time = audio.currentTime;
      const activeSeg = segments.find(s => time >= s.start && time <= s.end);
      if (activeSeg) {
        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const fontSize = (aspectRatio === '9:16' || aspectRatio === '3:4') ? width / 12 : width / 18;
        ctx.font = `900 ${fontSize}px sans-serif`;
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 15;
        ctx.fillText(activeSeg.text, width / 2, height / 2);
      }

      setExportProgress((audio.currentTime / audio.duration) * 100);
      animationFrameRef.current = requestAnimationFrame(drawFrame);
    };

    drawFrame();
  };

  return (
    <div className="w-full max-w-5xl mx-auto animate-fade-in mb-24">
      <div className="bg-slate-900 rounded-3xl shadow-2xl overflow-hidden border border-slate-800 relative">
        <div className="p-4 md:p-6 border-b border-slate-800 flex flex-col md:flex-row justify-between items-center gap-4 bg-slate-900/40">
          <div className="flex items-center gap-4">
            <button onClick={onReset} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition-all border border-slate-700">
              <ArrowLeft size={16} /> <span className="font-semibold text-xs">New Project</span>
            </button>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">Results</h2>
          </div>
          <div className="flex gap-2">
            <div className="flex bg-slate-800 p-0.5 rounded-xl border border-slate-700 items-center">
              <button 
                onClick={() => downloadTextFile(generateSRT(segments), 'srt')} 
                className="flex items-center gap-1.5 px-3 py-1 text-slate-400 hover:text-white text-[10px] font-bold transition-colors"
              >
                <FileText size={12} /> SRT
              </button>
              <div className="h-3 w-px bg-slate-700"></div>
              <button 
                onClick={() => downloadTextFile(generateLRC(segments, metadata, duration), 'lrc')} 
                className="flex items-center gap-1.5 px-3 py-1 text-slate-400 hover:text-white text-[10px] font-bold transition-colors"
              >
                <Music size={12} /> LRC
              </button>
              <div className="h-3 w-px bg-slate-700"></div>
              <button 
                onClick={() => downloadTextFile(generateTTML(segments, metadata), 'ttml')} 
                className="flex items-center gap-1.5 px-3 py-1 text-slate-400 hover:text-white text-[10px] font-bold transition-colors"
              >
                <Code2 size={12} /> TTML
              </button>
            </div>
            <button onClick={exportVideo} disabled={isExporting} className="flex items-center gap-2 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold disabled:opacity-50">
              {isExporting ? <Loader2 className="animate-spin" size={16} /> : <Video size={16} />} Export Video
            </button>
          </div>
        </div>

        <div className="px-6 py-3 bg-slate-950/20 border-b border-slate-800 flex items-center justify-between cursor-pointer" onClick={() => setIsSettingsOpen(!isSettingsOpen)}>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-slate-800 rounded-lg text-slate-400"><Settings size={16} /></div>
            <div><p className="text-xs font-bold text-white">Video & Metadata Configuration</p></div>
          </div>
          <div className="text-slate-500">{isSettingsOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</div>
        </div>

        {isSettingsOpen && (
          <div className="p-4 bg-slate-900/60 border-b border-slate-800 grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <input type="text" placeholder="Title" value={metadata.title} onChange={(e) => setMetadata({...metadata, title: e.target.value})} className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white outline-none" />
                <input type="text" placeholder="Artist" value={metadata.artist} onChange={(e) => setMetadata({...metadata, artist: e.target.value})} className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white outline-none" />
              </div>
              <div className="flex gap-2">
                {PRESET_COLORS.map((p) => (
                  <button key={p.name} onClick={() => setBgColor(p.hex)} className={`w-6 h-6 rounded-full border ${bgColor === p.hex ? 'border-white scale-110' : 'border-transparent'}`} style={{ backgroundColor: p.hex }} />
                ))}
              </div>
              <div className="pt-2 border-t border-slate-800/50 space-y-2">
                <div className="grid grid-cols-2 gap-2 p-1 bg-slate-800 rounded-lg">
                  <button onClick={() => setSelectedModel('gemini-2.5-flash')} className={`py-1 text-[9px] font-bold rounded ${selectedModel === 'gemini-2.5-flash' ? 'bg-indigo-600 text-white' : 'text-slate-500'}`}>2.5 Flash</button>
                  <button onClick={() => setSelectedModel('gemini-3-flash-preview')} className={`py-1 text-[9px] font-bold rounded ${selectedModel === 'gemini-3-flash-preview' ? 'bg-indigo-600 text-white' : 'text-slate-500'}`}>3 Flash</button>
                </div>
                <button onClick={onRetry} className="w-full flex items-center justify-center gap-2 py-1.5 bg-slate-800 text-white rounded-lg text-[10px] font-black border border-slate-700 hover:border-indigo-500/50">
                  <RefreshCw size={12} /> Re-process Audio
                </button>
              </div>
            </div>
            <div className="space-y-4">
              <div className="flex gap-2">
                {(['16:9', '9:16', '3:4'] as AspectRatio[]).map(r => (
                  <button key={r} onClick={() => setAspectRatio(r)} className={`flex-1 py-1.5 rounded-lg border transition-all text-[9px] font-bold ${aspectRatio === r ? 'bg-indigo-600/10 border-indigo-600 text-indigo-400' : 'bg-slate-800 border-transparent text-slate-500'}`}>{r}</button>
                ))}
              </div>
              <div className="flex bg-slate-800 p-1 rounded-lg border border-slate-700">
                {(['720p', '1080p'] as Resolution[]).map(res => (
                  <button key={res} onClick={() => setResolution(res)} className={`flex-1 py-1 text-[9px] font-bold rounded transition-all ${resolution === res ? 'bg-indigo-600 text-white' : 'text-slate-400'}`}>{res}</button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="bg-slate-950/40">
           {audioUrl && (
            <div className="p-3 bg-slate-900/80 border-b border-slate-800 sticky top-0 z-20 backdrop-blur-md">
              <audio 
                ref={audioRef} 
                src={audioUrl} 
                controls 
                className="w-full h-10 accent-indigo-500" 
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
              />
            </div>
          )}
          <div ref={containerRef} className="h-[400px] overflow-y-auto relative scroll-smooth">
            <div className="p-4 space-y-2">
              {segments.map((seg, idx) => (
                <div 
                  key={idx} 
                  ref={idx === activeIndex ? activeSegRef : null}
                  onClick={() => handleSeek(seg.start)} 
                  className={`flex gap-4 p-3 rounded-xl transition-all cursor-pointer border ${idx === activeIndex ? 'bg-indigo-600/10 border-indigo-500/30' : 'border-transparent hover:bg-slate-800/40'}`}
                >
                  <div className={`text-[10px] font-mono min-w-[70px] text-right pt-0.5 ${idx === activeIndex ? 'text-indigo-400' : 'text-slate-500'}`}>{formatToDisplayTime(seg.start)}</div>
                  <p className={`flex-1 text-sm ${idx === activeIndex ? 'text-white font-semibold' : 'text-slate-400'}`}>{seg.text}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {isExporting && (
          <div className="absolute inset-0 z-50 bg-slate-950/98 flex flex-col items-center justify-center p-12 text-center">
            <div className="text-3xl font-black text-white mb-4">{Math.round(exportProgress)}%</div>
            <button onClick={abortExport} className="px-5 py-2 bg-red-500/10 text-red-400 border border-red-500/30 rounded-xl text-[10px] font-bold">Abort Rendering</button>
          </div>
        )}
        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  );
};

export default ResultsView;
