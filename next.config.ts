import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Perf investigation: allows a second dev server (separate distDir) so
  // benchmarks run against local Postgres without touching the running one.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  /**
   * Dev-only: allow the dev server's internal resources (HMR websocket,
   * static chunks) to be requested from the LAN/Tailscale origins used to
   * test on real devices (e.g. Android Chrome over the tailnet).
   *
   * Without this, Next.js blocks cross-origin dev requests by default and
   * the phone's client runtime is degraded (dead HMR socket, stale chunks
   * after recompiles), which can make client-side navigation appear dead.
   *
   * This has no effect in production builds.
   */
  allowedDevOrigins: ["100.84.178.89", "10.93.67.15", "10.80.38.164", "fedora", "127.0.0.1"],
};

export default nextConfig;
