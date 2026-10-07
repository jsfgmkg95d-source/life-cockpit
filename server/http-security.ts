import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from './errors.ts';

export const MAX_BODY_BYTES = 64 * 1024;

export function securityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

export function makeSecurity(extraOrigins: string[] = [], epoch: () => string = () => '') {
  const secret = randomBytes(32);
  const currentToken = () => createHmac('sha256', secret).update(epoch()).digest('hex');
  const permittedOrigins = extraOrigins.map((origin) => {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.origin !== origin) {
      throw new Error('Additional origins must be exact local HTTP origins.');
    }
    return parsed.origin;
  });

  return {
    get token() { return currentToken(); },
    verify(request: IncomingMessage, port: number): void {
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(request.headers.host ?? '')) {
        throw new AppError(403, 'HOST_REJECTED', '请求地址不受信任，请从本机应用地址打开。');
      }
      const origins = [...hosts.map((host) => `http://${host}`), ...permittedOrigins];
      const origin = request.headers.origin;
      if ((origin !== undefined && !origins.includes(origin)) || request.headers['sec-fetch-site'] === 'cross-site') {
        throw new AppError(403, 'ORIGIN_REJECTED', '已拒绝其他网站发起的访问。');
      }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {
        const supplied = request.headers['x-csrf-token'];
        const token = currentToken();
        if (!origin || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
          throw new AppError(403, 'CSRF_REJECTED', '页面会话已失效，请刷新页面后重试。');
        }
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          throw new AppError(415, 'CONTENT_TYPE_REJECTED', '请求必须使用 JSON 格式。');
        }
      }
    },
  };
}

export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES) {
    throw new AppError(413, 'BODY_TOO_LARGE', '提交内容过长，请精简后重试。');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new AppError(413, 'BODY_TOO_LARGE', '提交内容过长，请精简后重试。');
    }
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError(400, 'INVALID_JSON', '提交内容不是有效的 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'INVALID_JSON', '提交内容必须是 JSON 对象。');
  }
  return value as Record<string, unknown>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

export async function staticFile(request: IncomingMessage, response: ServerResponse, distDir: string): Promise<void> {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) {
    throw new AppError(405, 'METHOD_NOT_ALLOWED', '此地址不支持当前操作。');
  }
  let pathname: string;
  try { pathname = decodeURIComponent((request.url ?? '/').split(/[?#]/)[0]); }
  catch { throw new AppError(400, 'INVALID_PATH', '页面地址格式不正确。'); }
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some((part) => part.startsWith('.'))) {
    throw new AppError(400, 'INVALID_PATH', '页面地址不受支持。');
  }
  let root: string;
  try { root = await realpath(distDir); }
  catch { throw new AppError(503, 'BUILD_REQUIRED', '页面尚未构建，请先完成应用构建后重新打开。'); }
  let file = resolve(root, `.${pathname}`);
  let extension = extname(file).toLowerCase();
  if (!extension) { file = resolve(root, 'index.html'); extension = '.html'; }
  if (!MIME[extension]) throw new AppError(404, 'NOT_FOUND', '未找到该页面资源。');
  try {
    file = await realpath(file);
    const child = relative(root, file);
    if (child.startsWith('..') || isAbsolute(child) || !(await stat(file)).isFile()) {
      throw new AppError(404, 'NOT_FOUND', '未找到该页面资源。');
    }
    const data = await readFile(file);
    response.writeHead(200, { 'Content-Type': MIME[extension], 'Content-Length': data.byteLength });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(404, 'NOT_FOUND', '未找到该页面资源。');
  }
}
