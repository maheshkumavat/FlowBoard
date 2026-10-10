import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

const isBrowser = typeof window !== 'undefined';

export const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseAnonKey || 'placeholder', {
  auth: {
    persistSession: isBrowser,
    autoRefreshToken: isBrowser,
    detectSessionInUrl: isBrowser,
    lock: async (name, acquireTimeout, fn) => await fn(),
  },
});

const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export const supabaseAdmin = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseServiceKey || 'placeholder', {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

// Single-flight token cache & listener
let cachedAccessToken = null;
let sessionFetchPromise = null;

if (isBrowser) {
  supabase.auth.onAuthStateChange((event, session) => {
    console.log(`[Supabase Auth Event ${new Date().toISOString()}] Event: ${event} | Token Present: ${!!session?.access_token}`);
    if (session?.access_token) {
      cachedAccessToken = session.access_token;
      const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
      const cookieOptions = `; path=/; max-age=604800; SameSite=Lax${isHttps ? '; Secure' : ''}`;
      document.cookie = `sb-access-token=${session.access_token}${cookieOptions}`;
      if (session.refresh_token) {
        document.cookie = `sb-refresh-token=${session.refresh_token}${cookieOptions}`;
      }
    } else if (event === 'SIGNED_OUT') {
      cachedAccessToken = null;
      document.cookie = 'sb-access-token=; path=/; max-age=0; SameSite=Lax';
      document.cookie = 'sb-refresh-token=; path=/; max-age=0; SameSite=Lax';
    }
  });
}

export function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    if (typeof atob === 'function') {
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      return JSON.parse(jsonPayload);
    } else if (typeof Buffer !== 'undefined') {
      const jsonPayload = Buffer.from(base64, 'base64').toString('utf8');
      return JSON.parse(jsonPayload);
    }
  } catch (e) {}
  return null;
}

export async function getValidAccessToken() {
  if (cachedAccessToken) {
    const decoded = decodeJwtPayload(cachedAccessToken);
    if (decoded && decoded.exp && decoded.exp * 1000 > Date.now() + 10000) {
      return cachedAccessToken;
    }
    cachedAccessToken = null;
  }
  if (!isBrowser) return null;

  // 1. Check document.cookie first (most reliable bridge across SSR and client)
  try {
    const match = document.cookie.match(/(?:^|;\s*)sb-access-token=([^;]+)/);
    if (match && match[1]) {
      const cookieToken = decodeURIComponent(match[1]);
      const decoded = decodeJwtPayload(cookieToken);
      if (decoded && decoded.exp && decoded.exp * 1000 > Date.now() + 10000) {
        cachedAccessToken = cookieToken;
        return cookieToken;
      }
    }
  } catch (e) {}

  // 2. Check exact project auth key in localStorage with expiration validation
  try {
    const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] || '';
    const exactKey = `sb-${projectRef}-auth-token`;
    const item = localStorage.getItem(exactKey) || localStorage.getItem('supabase.auth.token');

    if (item) {
      const parsed = JSON.parse(item);
      const tok = parsed?.access_token || parsed?.currentSession?.access_token;
      if (tok) {
        const decoded = decodeJwtPayload(tok);
        if (decoded && decoded.exp && decoded.exp * 1000 > Date.now() + 10000) {
          cachedAccessToken = tok;
          const isHttps = window.location.protocol === 'https:';
          document.cookie = `sb-access-token=${tok}; path=/; max-age=604800; SameSite=Lax${isHttps ? '; Secure' : ''}`;
          return cachedAccessToken;
        }
      }
    }

    // Fallback scan loop across all localStorage keys
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.includes('auth-token')) {
        const val = localStorage.getItem(key);
        if (val) {
          const parsed = JSON.parse(val);
          const tok = parsed?.access_token || parsed?.currentSession?.access_token;
          if (tok) {
            const decoded = decodeJwtPayload(tok);
            if (decoded && decoded.exp && decoded.exp * 1000 > Date.now() + 10000) {
              cachedAccessToken = tok;
              const isHttps = window.location.protocol === 'https:';
              document.cookie = `sb-access-token=${tok}; path=/; max-age=604800; SameSite=Lax${isHttps ? '; Secure' : ''}`;
              return cachedAccessToken;
            }
          }
        }
      }
    }
  } catch (e) {}

  // 3. Fetch/Refresh session from Supabase auth client if cache is empty or token is expiring
  if (!sessionFetchPromise) {
    sessionFetchPromise = (async () => {
      try {
        const getSessionPromise = supabase.auth.getSession();
        const timeoutPromise = new Promise((resolve) =>
          setTimeout(() => resolve({ data: { session: null }, error: new Error('getSession timeout (2000ms)') }), 2000)
        );
        const { data, error } = await Promise.race([getSessionPromise, timeoutPromise]);
        if (error) console.warn('[getValidAccessToken] getSession warning:', error.message || error);
        const token = data?.session?.access_token || null;
        if (token) {
          cachedAccessToken = token;
          if (isBrowser) {
            const isHttps = window.location.protocol === 'https:';
            document.cookie = `sb-access-token=${token}; path=/; max-age=604800; SameSite=Lax${isHttps ? '; Secure' : ''}`;
          }
          return token;
        }
        // If Supabase has no active session, clear stale cookie to prevent redirect loops
        if (isBrowser) {
          document.cookie = 'sb-access-token=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        }
        return null;
      } catch (err) {
        console.error('[getValidAccessToken] Exception:', err);
        return null;
      } finally {
        sessionFetchPromise = null;
      }
    })();
  }
  return sessionFetchPromise;
}

export async function ensureProfile(user) {
  if (!user || !user.id) return null;
  try {
    let fullUser = user;
    try {
      const { data: authData } = await supabaseAdmin.auth.admin.getUserById(user.id);
      if (authData?.user) {
        fullUser = authData.user;
      }
    } catch (authErr) {
      console.warn('ensureProfile getUserById warning:', authErr.message);
    }

    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', fullUser.id)
      .single();

    const nameFromMeta = fullUser.user_metadata?.name || fullUser.user_metadata?.full_name;
    const avatarUrlFromMeta = fullUser.user_metadata?.avatar_url || fullUser.user_metadata?.picture || null;
    const ghIdentity = fullUser.identities?.find((id) => id.provider === 'github');
    const ghFromIdentity = ghIdentity?.identity_data?.user_name || ghIdentity?.identity_data?.preferred_username;
    const ghFromMeta = fullUser.user_metadata?.user_name || fullUser.user_metadata?.github_username || fullUser.user_metadata?.preferred_username || ghFromIdentity || null;

    if (existing) {
      const updates = {};
      if (!existing.avatar_url && avatarUrlFromMeta) {
        updates.avatar_url = avatarUrlFromMeta;
      }
      if ((!existing.name || existing.name === 'User') && nameFromMeta) {
        updates.name = nameFromMeta;
      }
      if (!existing.github_username && ghFromMeta) {
        updates.github_username = ghFromMeta;
      }

      if (Object.keys(updates).length > 0) {
        const { data: updated } = await supabaseAdmin
          .from('profiles')
          .update(updates)
          .eq('id', fullUser.id)
          .select()
          .single();
        return updated || { ...existing, ...updates };
      }
      return existing;
    }

    const name = nameFromMeta || fullUser.email?.split('@')[0] || 'User';
    const { data: created, error } = await supabaseAdmin
      .from('profiles')
      .upsert({
        id: fullUser.id,
        name: name,
        email: fullUser.email,
        avatar_url: avatarUrlFromMeta,
        github_username: ghFromMeta,
        skill_profile: {},
        role: 'MEMBER',
      })
      .select()
      .single();

    if (error) {
      console.error('ensureProfile upsert error:', error);
      return null;
    }
    return created;
  } catch (err) {
    console.error('ensureProfile exception:', err);
    return null;
  }
}

// In-memory verified user token cache (fast 30s TTL to prevent redundant auth API calls)
const verifiedUserCache = new Map();
const VERIFIED_USER_CACHE_TTL_MS = 30 * 1000;

function cleanVerifiedUserCache() {
  const now = Date.now();
  if (verifiedUserCache.size > 500) {
    for (const [key, val] of verifiedUserCache.entries()) {
      if (val.expiresAt <= now) {
        verifiedUserCache.delete(key);
      }
    }
  }
}

export async function getServerUser(req) {
  const tStart = Date.now();
  try {
    if (req) {
      let token = null;

      const authHeader = req.headers?.get?.('authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }

      if (!token || token === 'null' || token === 'undefined') {
        const cookieHeader = req.headers?.get?.('cookie');
        if (cookieHeader) {
          const match = cookieHeader.match(/sb-access-token=([^;]+)/) || cookieHeader.match(/sb-[^=]+-auth-token=([^;]+)/);
          if (match) {
            token = match[1];
          }
        }
      }

      if (token && token !== 'null' && token !== 'undefined') {
        cleanVerifiedUserCache();

        // 1. Check verified in-memory token cache first (0ms latency, handles high concurrency)
        const cached = verifiedUserCache.get(token);
        if (cached && cached.expiresAt > Date.now()) {
          return cached.user;
        }

        // 2. Cryptographic verification using project's JWT Secret if provided
        const jwtSecret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET;
        if (jwtSecret) {
          try {
            const decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
            if (decoded && decoded.sub) {
              const verifiedUser = {
                id: decoded.sub,
                email: decoded.email || decoded.user_metadata?.email || '',
                user_metadata: decoded.user_metadata || {},
                app_metadata: decoded.app_metadata || {},
                role: decoded.role || 'authenticated',
              };
              const expMs = decoded.exp ? Math.min(Date.now() + VERIFIED_USER_CACHE_TTL_MS, decoded.exp * 1000) : Date.now() + VERIFIED_USER_CACHE_TTL_MS;
              verifiedUserCache.set(token, { user: verifiedUser, expiresAt: expMs });
              return verifiedUser;
            }
          } catch (jwtErr) {
            // If local secret verification fails (e.g. JWT_SECRET is app secret rather than Supabase project secret), fall through to Supabase Auth API
          }
        }

        // 3. Authoritative verification via Supabase Auth API
        const getUserPromise = supabaseAdmin.auth.getUser(token);
        const timeoutPromise = new Promise((resolve) =>
          setTimeout(() => resolve({ data: null, error: new Error('getServerUser timeout') }), 3000)
        );
        const res = await Promise.race([getUserPromise, timeoutPromise]);
        if (!res.error && res.data?.user) {
          let expMs = Date.now() + VERIFIED_USER_CACHE_TTL_MS;
          try {
            const decoded = jwt.decode(token);
            if (decoded && decoded.exp) {
              expMs = Math.min(expMs, decoded.exp * 1000);
            }
          } catch (e) {}

          verifiedUserCache.set(token, { user: res.data.user, expiresAt: expMs });
          return res.data.user;
        } else if (res.error) {
          console.warn(`[getServerUser ${new Date().toISOString()}] Auth verification failed (${Date.now() - tStart}ms):`, res.error?.message || res.error);
        }
      }
    }
  } catch (err) {
    console.error(`[getServerUser] Exception (${Date.now() - tStart}ms):`, err);
  }
  return null;
}

export async function fetchWithAuth(url, options = {}) {
  const tStart = Date.now();
  let token = options.token || cachedAccessToken;

  if (!token && isBrowser) {
    token = await getValidAccessToken();
  }

  const headers = {
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    let response = await fetch(url, {
      ...options,
      headers,
    });

    // Auto-retry on 401 by forcing session token refresh
    if (response.status === 401 && isBrowser) {
      console.warn(`[fetchWithAuth] 401 received for ${url}. Attempting token refresh...`);
      cachedAccessToken = null;
      const refreshedToken = await supabase.auth.getSession().then((res) => res.data?.session?.access_token || null);
      if (refreshedToken) {
        cachedAccessToken = refreshedToken;
        headers['Authorization'] = `Bearer ${refreshedToken}`;
        response = await fetch(url, {
          ...options,
          headers,
        });
      }
    }

    return response;
  } catch (err) {
    console.error(`[fetchWithAuth] Error calling ${url}:`, err);
    throw err;
  }
}

/**
 * Checks signed-in user's role in the project:
 * - Owner is always 'ADMIN'
 * - 'ADMIN', 'MEMBER', 'VIEWER' from project_members table
 * - Returns null if user is not a member of the project
 */
export async function getProjectMemberRole(projectId, currentUser) {
  if (!projectId || !currentUser) return null;
  try {
    const userId = typeof currentUser === 'string' ? currentUser : currentUser.id;
    const userEmail = typeof currentUser === 'object' ? currentUser.email : null;

    // 1. Check if user is original project owner
    const { data: proj } = await supabaseAdmin
      .from('projects')
      .select('owner_id')
      .eq('id', projectId)
      .maybeSingle();

    if (proj && proj.owner_id === userId) return 'ADMIN';

    // 2. Query project_members by user_id or profile email (case-insensitive)
    const { data: members } = await supabaseAdmin
      .from('project_members')
      .select('id, user_id, role, user:profiles(id, email)')
      .eq('project_id', projectId);

    if (!members || members.length === 0) return null;

    const matchedMember = members.find((m) =>
      m.user_id === userId ||
      m.user?.id === userId ||
      (userEmail && m.user?.email && m.user.email.toLowerCase() === userEmail.toLowerCase())
    );

    if (!matchedMember) return null;

    const roleStr = String(matchedMember.role || 'MEMBER').toUpperCase().trim();
    if (roleStr === 'ADMIN') return 'ADMIN';
    if (roleStr === 'VIEWER') return 'VIEWER';
    return 'MEMBER';
  } catch (e) {
    console.error('getProjectMemberRole exception:', e);
    return null;
  }
}

export async function checkIsProjectAdmin(projectId, currentUser) {
  const role = await getProjectMemberRole(projectId, currentUser);
  return role === 'ADMIN';
}
