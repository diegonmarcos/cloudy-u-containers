const SAFE_NAME_RE = /^[a-zA-Z0-9_.-]+$/;
const SAFE_SINCE_RE = /^\d+[smhd]$|^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/;

export function validateContainerName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
}

export function validateSince(since: string): void {
  if (!SAFE_SINCE_RE.test(since)) {
    throw new Error(`Invalid since format: ${since}. Expected: '1h', '30m', '2d', or '2024-01-01'`);
  }
}

export function validatePathComponent(path: string): void {
  if (!SAFE_NAME_RE.test(path)) {
    throw new Error(`Invalid path component: ${path}`);
  }
}
