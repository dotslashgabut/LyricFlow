import React, { useState, useEffect, useRef } from 'react';
import { SubtitleSegment } from '../types';
import { formatToSRTTime, generateLRC, generateSRT, formatToDisplayTime } from '../utils/timeUtils';
import { FileText, Music, RefreshCw, Play, Pause } from 'lucide-react';

interface ResultsViewProps {
  segments: SubtitleSegment[];
  onReset: () => void;
  audioName: string;
  audioFile: Blob | null;
}

const ResultsView: React.FC<ResultsViewProps> = ({ segments, onReset, audioName, audioFile }) => {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (audioFile) {
      const url = URL.createObjectURL(audioFile);
      setAudioUrl(url);
      return () => URL.revokeObjectURL(url);
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

  // Calculate active index based on current time
  useEffect(() => {
    const index = segments.findIndex(s => currentTime >= s.start && currentTime <= s.end);
    // Only update if changed to prevent unnecessary re-renders
    if (index !== activeIndex) {
      setActiveIndex(index);
    }
  }, [currentTime, segments, activeIndex]);

  // Auto-scroll to active segment when activeIndex changes
  useEffect(() => {
    if (activeIndex !== -1 && containerRef.current) {
      const element = document.getElementById(`segment-${activeIndex}`);
      if (element) {
        // Use nearest to avoid jumping the whole page, just the container
        element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [activeIndex]);

  const downloadFile = (content: string, extension: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const baseName = audioName.replace(/\.[^/.]+$/, "");
    a.download = `${baseName || 'transcription'}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="w-full max-w-4xl mx-auto animate-fade-in">
      <div className="bg-slate-800 rounded-2xl shadow-xl overflow-hidden border border-slate-700">
        
        {/* Header */}
        <div className="p-6 border-b border-slate-700 flex flex-col md:flex-row justify-between items-center gap-4 bg-slate-850">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <span className="w-2 h-8 bg-indigo-500 rounded-full"></span>
              Transcription Complete
            </h2>
            <p className="text-slate-400 text-sm mt-1 truncate max-w-xs md:max-w-md">
              Source: {audioName}
            </p>
          </div>
          <div className="flex gap-2">
             <button 
              onClick={() => downloadFile(generateSRT(segments), 'srt')}
              className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors text-sm font-medium"
            >
              <FileText size={16} />
              Download .SRT
            </button>
            <button 
              onClick={() => downloadFile(generateLRC(segments, { title: audioName }), 'lrc')}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors text-sm font-medium"
            >
              <Music size={16} />
              Download .LRC
            </button>
          </div>
        </div>

        {/* Audio Player Section */}
        {audioUrl && (
          <div className="p-4 bg-slate-900 border-b border-slate-800 flex justify-center sticky top-0 z-20">
            <audio 
              ref={audioRef}
              src={audioUrl}
              controls
              className="w-full max-w-2xl h-10 block accent-indigo-500"
              onTimeUpdate={handleTimeUpdate}
            />
          </div>
        )}

        {/* Preview Content */}
        <div 
          ref={containerRef}
          className="p-0 h-[500px] overflow-y-auto bg-slate-900/50 relative scroll-smooth"
        >
          <div className="relative z-0 p-6 space-y-2">
            {segments.length === 0 ? (
              <p className="text-center text-slate-500 py-10">No speech detected.</p>
            ) : (
              segments.map((seg, idx) => {
                const isActive = idx === activeIndex;
                return (
                  <div 
                    key={idx} 
                    id={`segment-${idx}`}
                    onClick={() => handleSeek(seg.start)}
                    className={`group flex gap-4 p-3 rounded-lg transition-all cursor-pointer border ${
                      isActive 
                        ? 'bg-indigo-600/20 border-indigo-500/50 ring-1 ring-indigo-500/30 shadow-[0_0_15px_rgba(79,70,229,0.1)] translate-x-1' 
                        : 'border-transparent hover:bg-slate-800/80 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex flex-col items-end min-w-[90px] pt-1 select-none">
                      <span className={`text-xs font-mono transition-colors ${isActive ? 'text-indigo-300 font-bold' : 'text-indigo-400/50'}`}>
                        {formatToDisplayTime(seg.start)}
                      </span>
                      <span className="text-[10px] font-mono text-slate-600">
                        {formatToDisplayTime(seg.end)}
                      </span>
                    </div>
                    <div className="flex-1 relative">
                      <p className={`text-lg leading-relaxed transition-colors ${isActive ? 'text-white font-medium' : 'text-slate-300'}`}>
                        {seg.text}
                      </p>
                      {isActive && (
                        <div className="absolute -left-3 top-1/2 -translate-y-1/2 w-1 h-8 bg-indigo-500 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"></div>
                      )}
                    </div>
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity self-center">
                        <button className="p-1.5 rounded-full bg-slate-700 hover:bg-indigo-600 text-white">
                            <Play size={12} fill="currentColor" />
                        </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 bg-slate-850 border-t border-slate-700 flex justify-center">
          <button 
            onClick={onReset}
            className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-sm font-medium px-4 py-2 hover:bg-slate-800 rounded-lg"
          >
            <RefreshCw size={14} />
            Start New Transcription
          </button>
        </div>
      </div>
    </div>
  );
};

export default ResultsView;