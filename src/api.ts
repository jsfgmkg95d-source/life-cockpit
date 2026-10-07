export class ApiError extends Error {
  status: number;
  code: string;
  fields?: Record<string, string>;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

let csrfToken = '';
// The document URL changes only after navigation commits. A cancelled beforeunload cannot switch API ledgers.
export function isDemoWorkspace(): boolean { return new URLSearchParams(window.location.search).get('workspace') === 'demo'; }
export function setWorkspace(workspace: 'personal' | 'demo'): void {
  const target = new URL(window.location.href);
  if (workspace === 'demo') target.searchParams.set('workspace', 'demo'); else target.searchParams.delete('workspace');
  window.location.assign(target.href);
}
export async function initializeSession(): Promise<void> {
  const session = await request<{ csrfToken: string }>('/api/session');
  csrfToken = session.csrfToken;
}

export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(isDemoWorkspace() && path !== '/api/session' ? path.replace(/^\/api\//u, '/api/demo/') : path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'x-csrf-token': csrfToken }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '连接未成功。请确认本地应用正在运行，然后重试；填写的内容仍然保留。');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, payload?.error?.code ?? 'REQUEST_FAILED',
      payload?.error?.message ?? '操作没有成功，填写的内容仍然保留，请重试。', payload?.error?.fields);
  }
  return payload as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作没有成功，请重试。';
}
