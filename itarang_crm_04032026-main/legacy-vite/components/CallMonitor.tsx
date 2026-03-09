import React, { useState, useEffect, useRef } from 'react';
import { Lead } from '../types';
import { AI_TRANSCRIPT_MOCK } from '../constants';
import { ArrowLeft, Mic, User, PhoneOff, Pause, Play, Activity } from 'lucide-react';

interface CallMonitorProps {
  lead: Lead;
  onBack: () => void;
}

export const CallMonitor: React.FC<CallMonitorProps> = ({ lead, onBack }) => {
  const [transcript, setTranscript] = useState<typeof AI_TRANSCRIPT_MOCK>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Simulate streaming transcript
  useEffect(() => {
    if (isPaused) return;

    if (currentIndex < AI_TRANSCRIPT_MOCK.length) {
      const timeout = setTimeout(() => {
        setTranscript(prev => [...prev, AI_TRANSCRIPT_MOCK[currentIndex]]);
        setCurrentIndex(prev => prev + 1);
      }, 1500); // New line every 1.5 seconds

      return () => clearTimeout(timeout);
    }
  }, [currentIndex, isPaused]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  return (
    <div className="h-[calc(100vh-140px)] flex flex-col animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
                <button onClick={onBack} className="p-2 hover:bg-gray-100 rounded-full text-gray-500">
                    <ArrowLeft className="w-5 h-5" />
                </button>
                <div>
                    <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                        Live Call Monitor
                        <span className="flex h-3 w-3 relative">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
                        </span>
                    </h2>
                    <p className="text-sm text-gray-500">Qualifying: {lead.name} • Phase: Product Discovery</p>
                </div>
            </div>
            <div className="flex items-center gap-3">
                <button 
                    onClick={() => setIsPaused(!isPaused)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${isPaused ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}
                >
                    {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                    {isPaused ? 'Resume AI' : 'Pause AI'}
                </button>
                <button className="flex items-center gap-2 px-4 py-2 bg-red-100 text-red-700 rounded-xl hover:bg-red-200 text-sm font-medium transition-colors">
                    <PhoneOff className="w-4 h-4" />
                    End Call
                </button>
            </div>
        </div>

        <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 min-h-0">
            {/* Transcript Area */}
            <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm flex flex-col overflow-hidden">
                <div className="p-4 border-b border-gray-100 bg-gray-50/50 flex justify-between items-center">
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Live Transcript</span>
                    <Activity className="w-4 h-4 text-green-500 animate-pulse" />
                </div>
                <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-white">
                    {transcript.map((line, idx) => (
                        <div key={idx} className={`flex items-start gap-4 ${line.speaker === 'AI' ? 'flex-row' : 'flex-row-reverse'}`}>
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${line.speaker === 'AI' ? 'bg-primary-100 text-primary-600' : 'bg-gray-100 text-gray-600'}`}>
                                {line.speaker === 'AI' ? <Mic className="w-4 h-4" /> : <User className="w-4 h-4" />}
                            </div>
                            <div className={`max-w-[80%] p-4 rounded-2xl text-sm leading-relaxed ${
                                line.speaker === 'AI' 
                                    ? 'bg-primary-50 text-gray-800 rounded-tl-none' 
                                    : 'bg-gray-100 text-gray-800 rounded-tr-none'
                            }`}>
                                <p className="font-semibold text-xs mb-1 opacity-70">{line.speaker}</p>
                                {line.text}
                            </div>
                        </div>
                    ))}
                    <div ref={bottomRef} />
                </div>
            </div>

            {/* AI Analysis Side Panel */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 flex flex-col gap-6">
                <div>
                    <h3 className="text-sm font-bold text-gray-900 mb-4 uppercase tracking-wider">Real-time Analysis</h3>
                    
                    <div className="space-y-4">
                        <div className="p-4 rounded-xl bg-gray-50 border border-gray-100">
                            <span className="text-xs text-gray-500">Customer Sentiment</span>
                            <div className="flex items-center gap-2 mt-1">
                                <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                                    <div className="h-full bg-green-500 w-[75%]"></div>
                                </div>
                                <span className="text-sm font-bold text-green-600">Positive</span>
                            </div>
                        </div>

                        <div className="p-4 rounded-xl bg-gray-50 border border-gray-100">
                            <span className="text-xs text-gray-500">Product Interest</span>
                            <p className="font-medium text-gray-900 mt-1">High (48V 40Ah Model)</p>
                        </div>

                        <div className="p-4 rounded-xl bg-gray-50 border border-gray-100">
                            <span className="text-xs text-gray-500">Identified Pain Point</span>
                            <p className="font-medium text-gray-900 mt-1">Current battery discharge rate</p>
                        </div>
                    </div>
                </div>

                <div className="mt-auto">
                     <h3 className="text-sm font-bold text-gray-900 mb-2">Suggested Actions</h3>
                     <button className="w-full py-3 border-2 border-dashed border-primary-200 bg-primary-50 text-primary-700 rounded-xl text-sm font-semibold hover:bg-primary-100 transition-colors">
                        Schedule Demo Visit
                     </button>
                </div>
            </div>
        </div>
    </div>
  );
};