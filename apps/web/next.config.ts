import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      ink: 'ink-web',
    },
  },
};

export default nextConfig;
