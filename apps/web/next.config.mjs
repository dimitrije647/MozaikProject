/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The browser only talks to the Next origin; /api/* is proxied to the Nest API.
  // This keeps the httpOnly session cookie first-party (no CORS or SameSite issues).
  async rewrites() {
    const api = process.env.API_URL ?? 'http://localhost:4000';
    return [{ source: '/api/:path*', destination: `${api}/:path*` }];
  },
};
export default nextConfig;
