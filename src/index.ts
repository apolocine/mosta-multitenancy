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

/** Resolver : par header HTTP (typique pour API B2B).
 *  @deprecated 0.2 — l'en-tête est accepté de N'IMPORTE QUEL appelant : n'importe qui choisit son
 *  client. Préférer `tenantFromHost({ header: { name, trusted } })`, qui ne l'écoute que d'un
 *  appelant de confiance. */
export function tenantFromHeader(headerName = 'x-tenant-id'): TenantResolver {
  return (req: any) => {
    const h = req.headers?.get
      ? req.headers.get(headerName)
      : req.headers?.[headerName] ?? req.headers?.[headerName.toLowerCase()]
    if (!h) return null
    return { id: String(h) }
  }
}

/** Resolver : par sous-domaine (`acme.example.com` → `acme`).
 *  @deprecated 0.2 — un seul domaine, aucun nom réservé hors `www`, et un hôte qui ne correspond pas
 *  au domaine donne quand même une clé (son premier label) au lieu d'être refusé. Préférer
 *  `tenantFromHost`. */
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

// ─── 0.2 — LE CLIENT D'APRÈS L'HÔTE, ou le REFUS (01/10/2026) ──────────────────────────────────
//
// Logique reprise de TicketFlow v0.3 (`lib/tenant.ts`, en production), sans ses deux défauts :
//   - l'en-tête de site y était accepté de TOUT appelant, et prioritaire sur l'hôte ;
//   - un hôte hors des domaines retombait sur un site « default » — la classe de l'incident du
//     15/09/2026, où des sites mal déclarés affichaient la configuration d'un autre.
// Ici, un hôte qui ne désigne pas un client connu est REFUSÉ (null). Il n'existe pas de client par
// défaut : c'est à l'application de dire ce qu'elle sert hors client (sa vitrine, sa console).

/** Options de `tenantFromHost` / `tenantKeyFromHost`. */
export interface HostTenantOptions {
  /** Domaines de base : tableau, ou liste séparée par des virgules (`amia.fr,mostajs.dev`). */
  domains: string | string[]
  /** Préfixes réservés à l'infrastructure (`www`, `admin`, `console`…) : jamais un client. */
  reserved?: string[]
  /** `host` (défaut) : `labo.amia.fr` ≠ `labo.mostajs.dev`. `prefix` : `labo`. */
  key?: 'host' | 'prefix'
  /** En-tête désignant le client — écouté SEULEMENT si `trusted(req)` est vrai (relais, console). */
  header?: { name: string; trusted: (req: any) => boolean }
}

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
const NOM = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`)

const listeDomaines = (d: string | string[]): string[] =>
  (Array.isArray(d) ? d : String(d || '').split(','))
    .map((x) => x.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean)

const enTete = (req: any, nom: string): string => {
  const h = req?.headers
  if (!h) return ''
  if (typeof h.get === 'function') return String(h.get(nom) ?? '')
  const v = h[nom.toLowerCase()] ?? h[nom]
  return String(Array.isArray(v) ? v[0] : v ?? '')
}

/** L'hôte d'une requête (node:http ou Fetch) : minuscules, sans port, sans point final. */
export function hostOf(req: any): string {
  let h = enTete(req, 'host')
  if (!h && typeof req?.url === 'string' && /^https?:\/\//i.test(req.url)) {
    try { h = new URL(req.url).host } catch { h = '' }
  }
  return h.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
}

/** La clé du client désigné par `host`, ou `null` — jamais une valeur par défaut. */
export function tenantKeyFromHost(host: string, opts: HostTenantOptions): string | null {
  const h = String(host || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  if (!h || !NOM.test(h)) return null
  const reserves = (opts.reserved || []).map((r) => r.toLowerCase())
  for (const base of listeDomaines(opts.domains)) {
    if (h === base || !h.endsWith(`.${base}`)) continue
    const prefixe = h.slice(0, h.length - base.length - 1)
    if (!prefixe || reserves.includes(prefixe)) return null
    return opts.key === 'prefix' ? prefixe : h
  }
  return null
}

/**
 * Résolveur : le client d'après l'hôte — ou d'après l'en-tête, si l'appelant est de confiance.
 * Rend `{ id, slug, metadata: { host, via } }`, ou `null` (refus).
 */
export function tenantFromHost(opts: HostTenantOptions): TenantResolver {
  return (req: any) => {
    if (opts.header && opts.header.trusted(req)) {
      const v = enTete(req, opts.header.name).trim().toLowerCase()
      if (v) return NOM.test(v) ? { id: v, slug: v.split('.')[0], metadata: { host: v, via: 'header' } } : null
    }
    const host = hostOf(req)
    const id = tenantKeyFromHost(host, opts)
    if (!id) return null
    return { id, slug: tenantKeyFromHost(host, { ...opts, key: 'prefix' }) ?? id, metadata: { host, via: 'host' } }
  }
}

/**
 * Adaptateur `node:http` : exécute `handler` dans le contexte du client résolu ; un client inconnu
 * reçoit **404** (pas 401 : ce n'est pas une affaire d'identité, l'adresse ne désigne rien).
 */
export function nodeTenantHandler(
  resolver: TenantResolver,
  handler: (req: any, res: any) => unknown,
  opts: { onUnknown?: (req: any, res: any) => void } = {},
): (req: any, res: any) => Promise<void> {
  return async (req, res) => {
    const tenant = await Promise.resolve(resolver(req))
    if (!tenant) {
      if (opts.onUnknown) return void opts.onUnknown(req, res)
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(`${JSON.stringify({ ok: false, code: 'TENANT_UNKNOWN', error: 'aucun client ne correspond à cette adresse' })}\n`)
      return
    }
    await _als.run(tenant, () => Promise.resolve(handler(req, res)))
  }
}

