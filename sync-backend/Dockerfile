FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
ENV PORT=8787
ENV SQLITE_PATH=/data/tabulabili-sync.db
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "src/node-server.js"]
