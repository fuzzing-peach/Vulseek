import type { ConnectionOptions } from "bullmq";

// 从 REDIS_URL 解析 Redis 连接信息
const parseRedisUrl = (url?: string): {host: string, port?: number} => {
	if (!url) {
		return {
			host: process.env.REDIS_HOST || "vulseek-redis-dev",
			port: process.env.REDIS_PORT ? Number.parseInt(process.env.REDIS_PORT) : 6379
		};
	}

	try {
		// redis://host:port 格式
		const parsed = new URL(url);
		return {
			host: parsed.hostname || "vulseek-redis-dev",
			port: parsed.port ? Number.parseInt(parsed.port) : 6379
		};
	} catch {
		// 如果解析失败，使用默认值
		return {
			host: url,
			port: 6379
		};
	}
};

const redisConnection = parseRedisUrl(process.env.REDIS_URL);

export const redisConfig: ConnectionOptions = {
	host: redisConnection.host,
	port: redisConnection.port,
};
