/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV === 'development'

const nextConfig = {
  // Relative asset URLs are needed by the packaged file:// build, but break
  // client hydration when served by the Next.js development server.
  ...(isDev ? {} : { output: 'export', trailingSlash: true, assetPrefix: './' }),
  images: {
    unoptimized: true,
  },
}

export default nextConfig
