FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
COPY migrations ./migrations
EXPOSE 3001
ENV NODE_ENV=production
CMD ["node", "src/server.js"]
