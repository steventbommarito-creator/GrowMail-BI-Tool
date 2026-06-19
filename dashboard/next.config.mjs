/** @type {import('next').NextConfig} */
const nextConfig = {
  // Force the data-agent context doc into the /api/chat serverless bundle so
  // it can be read with fs at runtime on Vercel. Without this, output file
  // tracing wouldn't include a markdown file read via a computed path.
  outputFileTracingIncludes: {
    '/api/chat': ['./OPENAI_CONTEXT.md'],
  },
};

export default nextConfig;
