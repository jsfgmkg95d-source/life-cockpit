// This local origin is enabled only for the Vite development proxy.
process.env.PCOS_ALLOWED_ORIGINS = 'http://127.0.0.1:5173';
await import('../server/index.ts');
export {};
