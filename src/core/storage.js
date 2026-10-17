/**
 * Tiny guarded wrappers over localStorage / sessionStorage. Both can throw (private mode, blocked cookies, in-app browsers),
 * so every access is wrapped; `set` reports whether the value really was stored (callers fall back to the URL when not).
 */
function make(kind) {
  const area = () => { try { return globalThis[kind]; } catch (e) { return null; } };   // the getter itself may throw
  return {
    get(key) {
      try { const s = area(); return s ? s.getItem(key) : null; } catch (e) { return null; }
    },
    /** value null/undefined removes the key. Returns true when the operation succeeded. */
    set(key, value) {
      try {
        const s = area();
        if (!s) return false;
        if (value == null) s.removeItem(key); else s.setItem(key, String(value));
        return true;
      } catch (e) { return false; }
    },
  };
}

export const local = make('localStorage');
export const session = make('sessionStorage');
