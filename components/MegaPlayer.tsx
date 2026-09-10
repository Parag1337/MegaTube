interface MegaPlayerProps {
  embedUrl: string;
  title: string;
}

/**
 * Full MEGA embed player for the video page.
 * Uses the normal embed URL (no autoplay/mute).
 */
export function MegaPlayer({ embedUrl, title }: MegaPlayerProps) {
  return (
    <div className="mega-player aspect-video w-full overflow-hidden rounded-xl border border-border bg-black">
      <iframe
        src={embedUrl}
        title={title}
        allow="autoplay; fullscreen; encrypted-media"
        allowFullScreen
        referrerPolicy="no-referrer"
      />
    </div>
  );
}