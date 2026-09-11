import { FileEntry } from '../types';

export interface CachedDirectory {
  files: FileEntry[];
  timestamp: number;
  sessionId: string;
  path: string;
}

// 5 minutes default TTL for session directory cache
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

class DirectoryCacheManager {
  private cache = new Map<string, CachedDirectory>();

  /**
   * Normalizes path to consistent format (removes trailing slashes, ensures leading slash)
   */
  private normalizePath(p: string): string {
    if (!p || p === '/' || p === '\\') return '/';
    let clean = p.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!clean.startsWith('/')) {
      clean = '/' + clean;
    }
    return clean || '/';
  }

  private makeKey(sessionId: string, path: string): string {
    return `${sessionId}:${this.normalizePath(path)}`;
  }

  /**
   * Retrieves cached directory entries if still valid according to TTL
   */
  public get(sessionId: string, path: string, maxAgeMs = DEFAULT_CACHE_TTL_MS): FileEntry[] | null {
    if (!sessionId) return null;
    const key = this.makeKey(sessionId, path);
    const entry = this.cache.get(key);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > maxAgeMs) {
      this.cache.delete(key);
      return null;
    }

    return entry.files;
  }

  /**
   * Stores fresh directory entries in cache
   */
  public set(sessionId: string, path: string, files: FileEntry[]): void {
    if (!sessionId) return;
    const norm = this.normalizePath(path);
    const key = this.makeKey(sessionId, norm);
    this.cache.set(key, {
      files,
      timestamp: Date.now(),
      sessionId,
      path: norm,
    });
  }

  /**
   * Checks whether a directory is currently cached and valid
   */
  public has(sessionId: string, path: string, maxAgeMs = DEFAULT_CACHE_TTL_MS): boolean {
    return this.get(sessionId, path, maxAgeMs) !== null;
  }

  /**
   * Invalidates a specific directory and its parent folder (e.g. after upload, delete, rename, mkdir)
   */
  public invalidate(sessionId: string, path: string): void {
    if (!sessionId) return;
    const norm = this.normalizePath(path);
    const exactKey = this.makeKey(sessionId, norm);
    this.cache.delete(exactKey);

    // Also invalidate parent directory
    const parts = norm.split('/').filter(Boolean);
    if (parts.length > 0) {
      parts.pop();
      const parentPath = '/' + parts.join('/');
      const parentKey = this.makeKey(sessionId, parentPath);
      this.cache.delete(parentKey);
    }
  }

  /**
   * Clears all cached directories for a particular session (e.g. on disconnect)
   */
  public invalidateSession(sessionId: string): void {
    if (!sessionId) return;
    const prefix = `${sessionId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clears all cached directories across all sessions
   */
  public clearAll(): void {
    this.cache.clear();
  }

  /**
   * Get diagnostic statistics
   */
  public getStats(): { count: number; paths: string[] } {
    return {
      count: this.cache.size,
      paths: Array.from(this.cache.keys()),
    };
  }
}

// Global singleton instance for the app lifecycle
export const directoryCache = new DirectoryCacheManager();
