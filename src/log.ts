/**
 * Diagnostics channel. stdout belongs exclusively to MCP JSON-RPC, so every
 * log line must go to stderr.
 */
export function log(message: string, meta?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  if (meta === undefined) {
    process.stderr.write(`[${timestamp}] ${message}\n`);
    return;
  }
  let rendered: string;
  try {
    rendered = JSON.stringify(meta);
  } catch {
    rendered = String(meta);
  }
  process.stderr.write(`[${timestamp}] ${message} ${rendered}\n`);
}
