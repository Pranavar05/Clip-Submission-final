import winston from 'winston';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// Custom log format for development / human readable console logs
const developmentFormat = printf(({ level, message, timestamp, stack, requestId, ...metadata }) => {
  const reqPart = requestId ? ` [Req: ${requestId}]` : '';
  let msg = `[${timestamp}] [${level}]${reqPart}: ${message}`;
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
export function getLoggerContext(requestId: string) {
  return {
    child: (metadata: Record<string, any>) => {
      return {
        info: (msg: string, extra: Record<string, any> = {}) => logger.info(msg, { requestId, ...metadata, ...extra }),
        debug: (msg: string, extra: Record<string, any> = {}) => logger.debug(msg, { requestId, ...metadata, ...extra }),
        warn: (msg: string, extra: Record<string, any> = {}) => logger.warn(msg, { requestId, ...metadata, ...extra }),
        error: (msg: string, extra: Record<string, any> = {}) => logger.error(msg, { requestId, ...metadata, ...extra }),
      };
    }
  };
}
