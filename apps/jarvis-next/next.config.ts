import type { NextConfig } from "next";

const gateway = process.env["JARVIS_GATEWAY_URL"] ?? "http://127.0.0.1:3001";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  transpilePackages: ["three"],
  eslint: { ignoreDuringBuilds: true },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${gateway}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
