// A few pages, so no router: "/" is the list, "/t/<threadId>" a thread,
// "/s/<slug>" a thread someone shared (no sign-in; share.tsx), "/new" a new
// thread, and the rail's views with what's open in them. Static
// hosting sends every unknown path to index.html, so a link works when
// opened cold.
import { useSyncExternalStore } from 'react';

export type RailView = 'scheduled' | 'projects' | 'runners' | 'usage';
export type Route = { page: 'list' } | { page: 'new' } | { page: 'thread'; threadId: string } | { page: 'share'; slug: string } | { page: RailView; id?: string };

// A path part, or undefined for a bad escape (/t/%E0): that page is the
// list, not a URIError that stops the whole site loading.
function part(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

function parse(): Route {
  const s = location.pathname.match(/^\/s\/([^/]+)\/?$/);
  const slug = s ? part(s[1]) : undefined;
  if (slug !== undefined) return { page: 'share', slug };
  const m = location.pathname.match(/^\/t\/([^/]+)\/?$/);
  const threadId = m ? part(m[1]) : undefined;
  if (threadId !== undefined) return { page: 'thread', threadId };
  if (/^\/new\/?$/.test(location.pathname)) return { page: 'new' };
  const v = location.pathname.match(/^\/(scheduled|projects|runners|usage)(?:\/([^/]+))?\/?$/);
  if (v) {
    const id = v[2] ? part(v[2]) : undefined;
    return { page: v[1] as RailView, ...(id !== undefined ? { id } : {}) };
  }
  return { page: 'list' };
}

let current = parse();
const listeners = new Set<() => void>();
window.addEventListener('popstate', () => {
  current = parse();
  listeners.forEach((l) => l());
});

export function go(path: string): void {
  if (path === location.pathname) return;
  history.pushState(null, '', path);
  current = parse();
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export function threadPath(threadId: string): string {
  return `/t/${encodeURIComponent(threadId)}`;
}

export function viewPath(view: RailView, id?: string): string {
  return id ? `/${view}/${encodeURIComponent(id)}` : `/${view}`;
}
