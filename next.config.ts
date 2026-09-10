import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
  allowedDevOrigins: ["100.84.178.89", "10.93.67.15", "fedora"],
};

export default nextConfig;
