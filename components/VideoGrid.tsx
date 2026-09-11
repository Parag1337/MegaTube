import { VideoCard } from './VideoCard';

export interface GridVideo {
  id: number;
  slug: string;
  title: string;
  megaUrl: string | null;
  megaFilename: string;
  thumbnail: string | null;
  duration?: number | null;
  creator: { slug: string; name: string } | null;
  isPrivate?: boolean;
}

/**
 * Standard discovery grid used by home, library, search, and creator pages:
 * 1 -> 2 -> 3 -> 4 columns across breakpoints with roomy row rhythm.
 */
export function VideoGrid({
  videos,
  priorityStart = 0,
}: {
  videos: GridVideo[];
  priorityStart?: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {videos.map((video, i) => (
        <VideoCard key={video.id} {...video} priority={i < priorityStart} />
      ))}
    </div>
  );
}