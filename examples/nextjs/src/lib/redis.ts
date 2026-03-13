import Redis from "ioredis";

export const redis = new Redis(
  // you can install redis locally with "brew install redis" and start with "brew services start redis"
  // you can monitor the redis server with "redis-cli monitor"
  process.env.REDIS_URL ?? "redis://localhost:6379",
);
