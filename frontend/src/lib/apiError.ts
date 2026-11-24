import { apiFetch } from "./api";

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? { ...value } : {};
}

export async function apiJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await apiFetch(input, init);
  if (response.ok) return response.json();
  const payload = record(await response.json().catch(() => undefined));
  const detail = record(payload.detail);
  const code = detail.code ?? payload.code;
  const message = detail.message ?? payload.detail ?? payload.message ?? payload.error;
  throw new ApiError(
    response.status,
    typeof code === "string" ? code : `HTTP_${response.status}`,
    typeof message === "string" && message.trim() ? message : response.statusText || `HTTP ${response.status}`,
  );
}
