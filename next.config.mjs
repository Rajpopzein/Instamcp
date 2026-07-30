/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The MCP transport streams responses; keep them uncached at the edge.
  async headers() {
    return [
      {
        source: '/api/mcp',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
};

export default nextConfig;
