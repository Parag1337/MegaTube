// Next.js route modules may only export route handlers and segment config.
// The implementation lives in handler.ts so unit tests can import
// `handleDownloadRequest`/`DownloadDeps` without polluting the route type
// surface (Next 16 validates every export of this file).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { GET, HEAD } from './handler';
