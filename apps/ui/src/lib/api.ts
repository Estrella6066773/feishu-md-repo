const DEFAULT_API_BASE = 'http://127.0.0.1:8787';

export function getApiBaseUrl(): string {
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL;
  }
  // 开发模式走 Vite 同源代理，避免 API 误打到 5173 静态服务
  if (import.meta.env.DEV) {
    return '';
  }
  return DEFAULT_API_BASE;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 404) {
      throw new Error(
        text.includes('Not Found')
          ? `接口不存在 (404)：${path}。请结束占用 8787 端口的旧 core-service 进程后重新运行 pnpm dev:service。`
          : text || `Request failed: 404`,
      );
    }
    throw new Error(text || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}
