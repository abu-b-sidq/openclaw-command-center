/**
 * Control UI deep links. A main session opens at /chat/<agentId>; any other session at
 * /chat/<agentId>/~key/<rest of the key, ":" → "/">. Empty when no Control UI URL is configured.
 */
export function sessionUrl(
  controlUiUrl: string | null | undefined,
  key: string | null | undefined,
): string {
  const m = /^agent:([^:]+):(.+)$/.exec(String(key || ''));
  if (!controlUiUrl || !m) return '';
  const base = `${controlUiUrl}/chat/${encodeURIComponent(m[1]!)}`;
  return m[2] === 'main'
    ? base
    : `${base}/~key/${m[2]!.split(':').map(encodeURIComponent).join('/')}`;
}

/** A Control UI path from the server (e.g. an approval's urlPath), made absolute. */
export function controlUiLink(
  controlUiUrl: string | null | undefined,
  path: string | null | undefined,
): string {
  if (!controlUiUrl || !path) return '';
  return `${controlUiUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}
