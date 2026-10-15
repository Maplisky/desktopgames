import pino from 'pino';

export const logger = pino({
  level: process.env.DG_LOG_LEVEL ?? 'info',
});
