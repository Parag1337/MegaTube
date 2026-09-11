'use client';

/**
 * Records a history entry when a video page is viewed. Fire-and-forget:
 * exactly one POST per page view, failures are silently ignored so playback
 * is never affected. Rendered only for signed-in viewers of playable
 * videos (the server decides); the API enforces ownership.
 */

import { useEffect, useRef } from 'react';

export default function RecordWatch({ videoId }: { videoId: number }) {
  const sentRef = useRef(false);
  useEffect(() => {
    if (sentRef.current) return;
    sentRef.current = true;
    fetch(`/api/history/${videoId}`, { method: 'POST' }).catch(() => {
      // History is advisory - a failed write must not disturb the viewer.
    });
  }, [videoId]);
  return null;
}
