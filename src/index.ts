// @mostajs/multitenancy — Tenant context + scoping helpers
// Author: Dr Hamid MADANI <drmdh@msn.com>
//
// Pattern : AsyncLocalStorage (Node ≥ 16) pour propager le tenantId à travers
// toute la stack async d'un handler HTTP (DB queries, calls externes, hooks,
// …) sans le passer manuellement en argument.
//
// Modèle : 1 tenant = 1 organization isolée des autres (sa data n'est jamais
// vue par les requêtes d'un autre tenant). Composable avec @mostajs/repository
// `withTenantScope` qui injecte automatiquement `tenantId` dans toutes les
// queries du repo.

import { AsyncLocalStorage } from 'node:async_hooks'

// ─── TenantContext (AsyncLocalStorage) ────────────────────────────────

export interface TenantInfo {
  id: string
  /** Nom affichable (optionnel ; lookup app-side sinon). */
  name?: string
  /** Slug pour les URLs (multi-tenant by subdomain ou path). */
  slug?: string
  /** User principal de la requête (utile pour audit). */
  userId?: string | null
  /** Metadata arbitraire (plan, features, etc.). */
  metadata?: Record<string, unknown>
}

const _als = new AsyncLocalStorage<TenantInfo>()

/** Retourne le tenantId du contexte courant ou `null` si hors d'un `run`. */
export function getCurrentTenantId(): string | null {
  return _als.getStore()?.id ?? null
}

/** Retourne le `TenantInfo` complet ou `null`. */
export function getCurrentTenant(): TenantInfo | null {
  return _als.getStore() ?? null
}

/** Exécute `fn` dans un contexte tenant. Tous les `await` à l'intérieur
 *  héritent du même tenant via AsyncLocalStorage. */
export function runWithTenant<T>(tenant: TenantInfo, fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve(_als.run(tenant, fn))
}

/** Détache temporairement (`null`) pour des opérations cross-tenant (admin).
 *  À utiliser avec extrême précaution. */
export function runWithoutTenant<T>(fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve(_als.run(undefined as any, fn))
}

/** Throw si pas de tenant. À mettre au début d'un service tenant-scoped. */
export function requireTenant(): TenantInfo {
  const t = _als.getStore()
  if (!t) throw new Error('[multitenancy] no current tenant — wrap call in runWithTenant()')
  return t
}

// ─── Tenant resolvers ──────────────────────────────────────────────────

/** Stratégie pour extraire le tenant depuis une requête HTTP. */
export type TenantResolver = (req: Request | { headers: any; url: string }) =>
  Promise<TenantInfo | null> | TenantInfo | null

/** Resolver : par header HTTP (typique pour API B2B). */
export function tenantFromHeader(headerName = 'x-tenant-id'): TenantResolver {
  return (req: any) => {
    const h = req.headers?.get
      ? req.headers.get(headerName)
      : req.headers?.[headerName] ?? req.headers?.[headerName.toLowerCase()]
    if (!h) return null
    return { id: String(h) }
  }
}

/** Resolver : par sous-domaine (`acme.example.com` → `acme`). */
export function tenantFromSubdomain(opts?: { rootDomain?: string }): TenantResolver {
  const rootRe = opts?.rootDomain
    ? new RegExp(`\\.${opts.rootDomain.replace(/\./g, '\\.')}$`)
    : null
  return (req: any) => {
    const host = String(req.headers?.host ?? req.headers?.get?.('host') ?? '')
    if (!host) return null
    let slug = host.split(':')[0].split('.')[0]
    if (rootRe && rootRe.test(host)) {
      // Strict mode : ne match que si le host se termine par rootDomain
      slug = host.replace(rootRe, '').split('.').slice(-1)[0]
    }
    if (!slug || slug === 'www') return null
    return { id: slug, slug }
  }
}

/** Resolver : par path prefix (`/t/:tenantSlug/...`). */
export function tenantFromPath(opts?: { prefix?: string }): TenantResolver {
  const prefix = opts?.prefix ?? '/t/'
  return (req: any) => {
    const url = req.url ?? req.path ?? ''
    if (!url.startsWith(prefix)) return null
    const slug = url.slice(prefix.length).split('/')[0]
    if (!slug) return null
    return { id: slug, slug }
  }
}

/** Combine plusieurs resolvers — premier match gagne. */
export function combineResolvers(...resolvers: TenantResolver[]): TenantResolver {
  return async (req) => {
    for (const r of resolvers) {
      const t = await Promise.resolve(r(req))
      if (t) return t
    }
    return null
  }
}

// ─── Middlewares ───────────────────────────────────────────────────────

/** Crée un middleware Express-like qui exécute `next()` dans le contexte tenant.
 *  Si pas de tenant détecté, retourne 401 par défaut (configurable). */
export function expressTenantMiddleware(opts: {
  resolver: TenantResolver
  /** Comportement si pas de tenant : 'reject' (401) | 'allow' (continue sans tenant) | callback. */
  onMissing?: 'reject' | 'allow' | ((req: any, res: any) => void)
}) {
  return (req: any, res: any, next: any) => {
    Promise.resolve(opts.resolver(req)).then(tenant => {
      if (!tenant) {
        if (opts.onMissing === 'allow') return next()
        if (typeof opts.onMissing === 'function') return opts.onMissing(req, res)
        res.statusCode = 401
        res.end('Tenant not found')
        return
      }
      _als.run(tenant, () => next())
    }).catch(next)
  }
}

/** Wrapper Web-standard Fetch (Next.js App Router, Hono, Bun, Deno...).
 *
 *  ```ts
 *  export async function GET(req: Request) {
 *    return withTenant(req, { resolver: tenantFromHeader() }, async () => {
 *      // ... handler logic, getCurrentTenantId() retourne la bonne valeur
 *    })
 *  }
 *  ```
 */
export async function withTenant<T>(
  req: Request,
  opts: { resolver: TenantResolver; onMissing?: 'reject' | 'allow' },
  fn: () => Promise<T>,
): Promise<T | Response> {
  const tenant = await Promise.resolve(opts.resolver(req))
  if (!tenant) {
    if (opts.onMissing === 'allow') return fn()
    return new Response('Tenant not found', { status: 401 }) as any
  }
  return runWithTenant(tenant, fn)
}

// ─── Tenant policy (allow/deny lists) ─────────────────────────────────

export interface TenantPolicy {
  /** Allow-list explicite (si renseignée, deny tout autre). */
  allowedIds?: string[]
  /** Deny-list (priorité sur allowedIds). */
  blockedIds?: string[]
  /** Validation custom (cohorte, plan actif, etc.). */
  validate?: (tenant: TenantInfo) => Promise<boolean> | boolean
}

export async function checkTenantPolicy(tenant: TenantInfo, policy?: TenantPolicy): Promise<boolean> {
  if (!policy) return true
  if (policy.blockedIds?.includes(tenant.id)) return false
  if (policy.allowedIds && !policy.allowedIds.includes(tenant.id)) return false
  if (policy.validate) return await Promise.resolve(policy.validate(tenant))
  return true
}
