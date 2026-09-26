import type { NextConfig } from "next";

const config: NextConfig = {
  experimental: { cpus: 1 },
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Frame-Options", value: "DENY" },
    ] }];
  },
};
export default config;
