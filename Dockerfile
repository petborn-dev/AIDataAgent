# Single stage build - keep all dependencies since vite is needed at runtime
FROM node:20-slim

WORKDIR /app

# Copy package files and patches
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches

# Install pnpm and ALL dependencies (including devDependencies - vite is needed at runtime)
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the application (vite build + esbuild)
RUN pnpm run build

# Expose port
EXPOSE 8080

# Set environment
ENV NODE_ENV=production
ENV PORT=8080

# Start the application
CMD ["node", "dist/index.js"]
