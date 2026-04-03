import { startLocalProxy } from './src/credential-proxy.ts';
import { LOCAL_PROXY_PORT, LOCAL_CONTEXT_WINDOWS } from './src/config.ts';

startLocalProxy(
  LOCAL_PROXY_PORT,
  process.env.LOCAL_PROXY_UPSTREAM || 'http://192.168.1.95:8080',
  'glm-4.7-flash',
  '127.0.0.1',
  LOCAL_CONTEXT_WINDOWS['glm-4.7-flash'] || 4096
).then(() => {
  console.log('Local proxy started successfully');
}).catch((err) => {
  console.error('Failed to start proxy:', err);
  process.exit(1);
});