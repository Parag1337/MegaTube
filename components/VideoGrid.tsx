import { VideoCard } from './VideoCard';

export interface GridVideo {
  id: number;
  slug: string;
  title: string;
  megaUrl: string | null;
  megaFilename: string;
  thumbnail: string | null;
  creator: { slug: string; name: string } | null;
}

export function VideoGrid({
  videos,
  priorityStart = 0,
}: {
  videos: GridVideo[];
  priorityStart?: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {videos.map((video, i) => (
        <VideoCard key={video.id} {...video} priority={i < priorityStart} />
      ))}
    </div>
  );
}