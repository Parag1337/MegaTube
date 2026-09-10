'use client';

import { useState, useRef, useEffect } from 'react';

interface PrivatePlayerProps {
  videoId: number;
  title: string;
}

export function PrivatePlayer({ videoId, title }: PrivatePlayerProps) {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleLoadStart = () => {
      setIsLoading(true);
      setError(null);
    };

    const handleCanPlay = () => {
      setIsLoading(false);
      setError(null);
    };

    const handleError = () => {
      setIsLoading(false);
      if (video.error) {
        const errorMessages: Record<number, string> = {
          1: 'Video loading was aborted',
          2: 'Network error occurred while loading the video',
          3: 'Video decoding failed',
          4: 'Video format not supported by this browser',
        };
        const errorMessage = errorMessages[video.error.code] || 'Unknown video error';
        
        if (video.error.code === 1) {
          return;
        }
        
        setError(errorMessage);

        if (video.error.code === 4 || mimeType === 'video/mp2t') {
          setError('This video format (MPEG-TS) is not supported by your browser. MP4 format is recommended.');
        }
      }
    };

    fetch(`/api/media/${videoId}`, { method: 'HEAD' })
      .then(res => {
        const contentType = res.headers.get('content-type');
        if (contentType) {
          setMimeType(contentType);
          if (contentType === 'video/mp2t') {
            console.warn('MPEG-TS format detected - limited browser support');
          }
        }
      })
      .catch(() => {
        // MIME type detection failed, but video might still work
      });

    video.addEventListener('loadstart', handleLoadStart);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('error', handleError);

    return () => {
      video.removeEventListener('loadstart', handleLoadStart);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('error', handleError);
    };
  }, [videoId, mimeType]);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
      {error ? (
        <div className="flex h-full w-full flex-col items-center justify-center bg-surface px-6 text-center">
          <div className="text-destructive mb-3">
            <svg className="h-10 w-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <p className="text-base font-medium">Video cannot be played</p>
          <p className="mt-2 text-sm text-muted">{error}</p>
          {mimeType === 'video/mp2t' && (
            <p className="mt-3 text-xs text-muted">
              This video is in MPEG-TS format, which has limited browser support.
              Consider converting it to MP4 format for better compatibility.
            </p>
          )}
        </div>
      ) : (
        <>
          <video
            ref={videoRef}
            key={videoId}
            controls
            preload="metadata"
            playsInline
            suppressHydrationWarning
            className="h-full w-full"
            src={`/api/media/${videoId}`}
          >
            <track kind="captions" />
          </video>
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <div className="text-white">
                <svg className="animate-spin h-8 w-8" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
            </div>
          )}
        </>
      )}
      <span className="sr-only">{title}</span>
    </div>
  );
}
