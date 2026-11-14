import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: "4mb" } }, // certificates uploaded on the clerk questionnaire
};

export default nextConfig;
