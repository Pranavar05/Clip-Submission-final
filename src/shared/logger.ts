import winston from 'winston';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// Custom log format for development / human readable console logs
const developmentFormat = printf(({ level, message, timestamp, stack, requestId, submissionId, queueId, workerId, ...metadata }) => {
  let contextPart = '';
  if (requestId) contextPart += ` [Req: ${requestId}]`;
  if (submissionId) contextPart += ` [Sub: ${submissionId}]`;
  if (queueId) contextPart += ` [Queue: ${queueId}]`;
  if (workerId) contextPart += ` [Worker: ${workerId}]`;

  let msg = `[${timestamp}] [${level}]${contextPart}: ${message}`;
  if (stack) {
    msg += `\nStack: ${stack}`;
  }
  if (Object.keys(metadata).length > 0 && !(level.includes('info') || level.includes('debug'))) {
    msg += `\nMetadata: ${JSON.stringify(metadata, null, 2)}`;
  }
  return msg;
});

// Production JSON format includes request ID and structured metadata naturally
const productionFormat = combine(
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  json()
);

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: process.env.NODE_ENV === 'production' 
    ? productionFormat 
    : combine(
        errors({ stack: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        developmentFormat
      ),
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production'
        ? undefined // Uses default productionFormat
        : combine(
            colorize({ all: true }),
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            developmentFormat
          )
    })
  ]
});

/**
 * Utility to construct a logging context with a Correlation ID (Request ID)
 */
export function getLoggerContext(requestId: string, submissionId?: string, queueId?: string, workerId?: string) {
  return {
    child: (metadata: Record<string, any>) => {
      const ids = { requestId, submissionId, queueId, workerId };
      return {
        info: (msg: string, extra: Record<string, any> = {}) => logger.info(msg, { ...ids, ...metadata, ...extra }),
        debug: (msg: string, extra: Record<string, any> = {}) => logger.debug(msg, { ...ids, ...metadata, ...extra }),
        warn: (msg: string, extra: Record<string, any> = {}) => logger.warn(msg, { ...ids, ...metadata, ...extra }),
        error: (msg: string, extra: Record<string, any> = {}) => logger.error(msg, { ...ids, ...metadata, ...extra }),
      };
    }
  };
}
