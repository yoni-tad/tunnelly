import { startServer } from './tunnellyServer.js';
import { createLogger } from './utils/logger.js';

async function main() {
  const server = await startServer();
  const { config, logger } = server;

  logger.info(`Server started on ${config.host}:${server.port}`, { env: config.nodeEnv });
  logger.info(`Public URL: ${config.publicUrl}`);
  logger.info(`Dashboard:  ${config.publicUrl}/_tunnelly/`);
  if (!config.dashboardPassword) logger.warn('DASHBOARD_PASSWORD is not set — dashboard is unauthenticated (dev only)');

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    logger.info(`Received ${signal}, shutting down`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err: Error) => {
  createLogger().error(`Failed to start: ${err.message}`);
  process.exit(1);
});
