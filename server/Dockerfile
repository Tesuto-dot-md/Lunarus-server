FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production --ignore-scripts

COPY src/ ./src/

EXPOSE 8080

CMD ["node", "src/index.js"]