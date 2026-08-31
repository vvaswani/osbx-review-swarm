FROM oven/bun:1.4-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN bun install

# Copy source
COPY . .

EXPOSE 8000

CMD ["bun", "run", "src/main.ts"]
