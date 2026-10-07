import { createApp } from './app.ts';

const app = createApp({
  port: process.env.PCOS_PORT === undefined ? 4317 : Number(process.env.PCOS_PORT),
  dataDir: process.env.PCOS_DATA_DIR,
  distDir: process.env.PCOS_DIST_DIR,
  allowedOrigins: process.env.PCOS_ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean),
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await app.close();
  if (process.connected) process.disconnect();
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
// A desktop parent can stop only its own child, without an HTTP shutdown route.
process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'pcos-shutdown') void stop();
});
process.on('disconnect', () => { void stop(); });

try {
  const address = await app.listen();
  console.log(`PCOS_READY ${JSON.stringify({ ...address, processId: process.pid })}`);
} catch (error) {
  await app.close();
  console.error(error instanceof Error ? error.message : '本地服务启动失败。');
  process.exitCode = 1;
}
