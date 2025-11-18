import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  stream: MediaStream | null;
  isRecording: boolean;
}

const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ stream, isRecording }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>();
  const analyserRef = useRef<AnalyserNode>();
  const contextRef = useRef<AudioContext>();

  useEffect(() => {
    if (!stream || !isRecording) {
      if (contextRef.current && contextRef.current.state !== 'closed') {
        contextRef.current.close();
      }
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
      return;
    }

    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    contextRef.current = audioContext;
    
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    
    analyser.fftSize = 256;
    source.connect(analyser);
    analyserRef.current = analyser;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    const draw = () => {
      if (!canvasRef.current) return;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 2;
        
        // Gradient fill
        const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
        gradient.addColorStop(0, '#818cf8'); // Indigo 400
        gradient.addColorStop(1, '#4f46e5'); // Indigo 600

        ctx.fillStyle = gradient;
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);

        x += barWidth + 1;
      }

      requestRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      if (audioContext.state !== 'closed') audioContext.close();
    };
  }, [stream, isRecording]);

  return (
    <canvas 
      ref={canvasRef} 
      width={300} 
      height={60} 
      className="w-full h-16 rounded bg-slate-900/50"
    />
  );
};

export default AudioVisualizer;