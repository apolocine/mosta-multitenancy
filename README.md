# @mostajs/multitenancy

**Auteur** : Dr Hamid MADANI <drmdh@msn.com>
**License** : AGPL-3.0-or-later
**Version** : 0.1.0

Tenant context et scoping pour applications SaaS multi-tenant de l'écosystème `@mostajs/*`. Propagation automatique du `tenantId` à travers toute la stack async d'un handler HTTP via `AsyncLocalStorage` Node.js, middlewares prêts à l'emploi pour Express/Next.js/Fastify, resolvers par header / subdomain / path, et composition avec `@mostajs/repository.withTenantScope` pour filtrer automatiquement les queries DB.

---

## Table des matières

1. [Pourquoi un module multi-tenant ?](#1-pourquoi-un-module-multi-tenant-)
2. [Architecture](#2-architecture)
3. [Quick start — how to use](#3-quick-start--how-to-use)
4. [API détaillée](#4-api-détaillée)
5. [Implémentation — how to impl](#5-implémentation--how-to-impl)
6. [Stratégies de résolution du tenant](#6-stratégies-de-résolution-du-tenant)
7. [Tenant policy (allow / deny / custom)](#7-tenant-policy-allow--deny--custom)
8. [Patterns avancés](#8-patterns-avancés)
9. [Tests](#9-tests)
10. [Troubleshooting & pièges courants](#10-troubleshooting--pièges-courants)
11. [Modules liés](#11-modules-liés)

---

## 1. Pourquoi un module multi-tenant ?

Le multi-tenant SaaS impose deux problèmes opposés :
1. **Isolation des données** entre clients (jamais voir/modifier les données d'un autre).
2. **Partage du code et de l'infrastructure** (un seul déploiement gère N clients).

Sans module dédié, le `tenantId` doit être **passé manuellement** à travers chaque fonction → fragile, oubli garanti à un moment ou un autre = data leak inter-tenant.

`@mostajs/multitenancy` règle ça via **`AsyncLocalStorage`** Node.js : le tenant est posé une fois au début du handler HTTP, et toute la pile async hérite du même contexte sans le passer en argument. Combiné à `@mostajs/repository.withTenantScope`, les queries DB sont filtrées automatiquement → impossible d'oublier le filtre.

**Bénéfices** :
- Aucune fuite de `tenantId` manuelle dans le code applicatif
- Isolation par défaut (queries au mauvais tenant retournent `null`/`[]` au lieu de exposer d'autres tenants)
- Composable avec tout module qui accepte un callback `getTenantId`
- Resolvers configurables : header HTTP (B2B), subdomain (SaaS classique), path prefix, custom

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ HTTP Request arrives at handler                               │
│   GET https://acme.example.com/api/articles                   │
└─────────────────┬────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────────┐
│ Tenant resolver                                               │
│   tenantFromSubdomain() → { id: 'acme', slug: 'acme' }        │
└─────────────────┬────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────────┐
│ AsyncLocalStorage.run(tenant, () => handler())                │
└─────────────────┬────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────────┐
│ Handler logic                                                 │
│   await articles.find()                                       │
│       ↓                                                       │
│   withTenantScope intercepte :                                │
│     filter = { ...originalFilter, tenantId: 'acme' }          │
│       ↓                                                       │
│   Repository → data-plug → Mongo/Postgres                     │
│     SELECT * FROM articles WHERE tenant_id = 'acme'           │
└──────────────────────────────────────────────────────────────┘
```

Note : `AsyncLocalStorage` est natif Node ≥ 16, zero dep, sûr en concurrent (chaque chain d'async a son propre store).

---

## 3. Quick start — how to use

### Installation

```bash
npm install @mostajs/multitenancy
```

### Cas le plus simple — middleware Express

```ts
import express from 'express'
import { expressTenantMiddleware, tenantFromHeader, getCurrentTenantId } from '@mostajs/multitenancy'

const app = express()

app.use(expressTenantMiddleware({
  resolver: tenantFromHeader('x-tenant-id'),
}))

app.get('/articles', async (req, res) => {
  const tenantId = getCurrentTenantId()  // 'acme', extrait du header X-Tenant-Id
  // ... fais quelque chose avec le tenantId
  res.json({ tenantId })
})
```

### Next.js App Router

```ts
// app/api/articles/route.ts
import { withTenant, tenantFromHeader, getCurrentTenantId } from '@mostajs/multitenancy'

export async function GET(req: Request) {
  return withTenant(req, { resolver: tenantFromHeader() }, async () => {
    const tenantId = getCurrentTenantId()  // contexte propagé
    return Response.json({ tenantId })
  })
}
```

### Avec @mostajs/repository pour scoping DB automatique

```ts
import { createRepository, withTenantScope } from '@mostajs/repository'
import { getCurrentTenantId } from '@mostajs/multitenancy'

interface Article { id: string; title: string; tenantId: string }

export const articleRepo = withTenantScope(
  createRepository<Article>({ collection: 'articles' }),
  { getTenantId: getCurrentTenantId },
)

// Dans le handler (déjà dans un contexte tenant) :
const all = await articleRepo.find()
// → SELECT * FROM articles WHERE tenant_id = '<current>'
// Aucun risque de voir les articles des autres tenants — la query est filtrée automatiquement.

await articleRepo.save({ id: 'a-1', title: 'Hello', tenantId: '' })
// → tenantId est injecté automatiquement avec le tenant courant
```

---

## 4. API détaillée

### TenantInfo

```ts
interface TenantInfo {
  id: string                          // identifiant unique (UUID, slug, etc.)
  name?: string                       // nom affichable
  slug?: string                       // slug URL-friendly
  userId?: string | null              // user principal (pour audit)
  metadata?: Record<string, unknown>  // libre : plan, features, limits, etc.
}
```

### Context functions

| Fonction | Effet |
|---|---|
| `getCurrentTenantId(): string \| null` | Retourne l'id du tenant courant, ou null si hors d'un `run` |
| `getCurrentTenant(): TenantInfo \| null` | Retourne le TenantInfo complet |
| `requireTenant(): TenantInfo` | Idem mais throw si pas de tenant (à utiliser en début de service tenant-scoped) |
| `runWithTenant(tenant, fn)` | Exécute `fn()` dans un contexte tenant |
| `runWithoutTenant(fn)` | Exécute sans tenant (admin cross-tenant — usage rare et explicite) |

### Resolvers

| Resolver | Signature | Cas d'usage |
|---|---|---|
| `tenantFromHeader(name?)` | `(req) => TenantInfo \| null` | API B2B (header `X-Tenant-Id`) |
| `tenantFromSubdomain(opts?)` | `(req) => TenantInfo \| null` | SaaS multi-domain (`acme.example.com`) |
| `tenantFromPath(opts?)` | `(req) => TenantInfo \| null` | Path-based (`/t/acme/...`) |
| `combineResolvers(...)` | `(req) => TenantInfo \| null` | Fallback chain (header, then subdomain, then path) |

### Middlewares

```ts
// Express / Connect-style
expressTenantMiddleware({
  resolver: TenantResolver,
  onMissing?: 'reject' | 'allow' | (req, res) => void
})

// Web-standard Fetch (Next.js, Hono, Bun, Deno)
withTenant<T>(req: Request, opts: { resolver; onMissing? }, fn: () => Promise<T>)
```

### Policy

```ts
interface TenantPolicy {
  allowedIds?: string[]    // si défini, deny tout autre
  blockedIds?: string[]    // priorité sur allowedIds
  validate?: (tenant: TenantInfo) => Promise<boolean> | boolean
}

checkTenantPolicy(tenant: TenantInfo, policy?: TenantPolicy): Promise<boolean>
```

---

## 5. Implémentation — how to impl

### Pattern 1 — SaaS classique par subdomain

Architecture cible : `acme.app.com`, `globex.app.com`, etc. Chaque tenant a son sous-domaine, accède à ses propres données.

```ts
// lib/tenant.ts
import {
  tenantFromSubdomain,
  expressTenantMiddleware,
  checkTenantPolicy,
} from '@mostajs/multitenancy'
import { tenantsRepo } from './repos'

export const tenantMiddleware = expressTenantMiddleware({
  resolver: tenantFromSubdomain({ rootDomain: 'app.com' }),
  onMissing: async (req, res) => {
    res.statusCode = 404
    res.send('No tenant — visit https://www.app.com/signup')
  },
})

// En profondeur : on enrichit le TenantInfo depuis DB après resolution
import { runWithTenant, getCurrentTenantId } from '@mostajs/multitenancy'

export async function enrichAndRun<T>(fn: () => Promise<T>): Promise<T> {
  const slug = getCurrentTenantId()
  if (!slug) throw new Error('No tenant')
  const tenant = await tenantsRepo.findById(slug)
  if (!tenant) throw new Error(`Tenant '${slug}' not provisioned`)
  return runWithTenant({
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    metadata: { plan: tenant.plan, features: tenant.features },
  }, fn)
}
```

### Pattern 2 — API B2B par header (token-based)

Pour des intégrations B2B où le tenant est identifié par un token API + header :

```ts
import { expressTenantMiddleware, tenantFromHeader } from '@mostajs/multitenancy'

app.use(async (req, res, next) => {
  const apiKey = req.headers.authorization?.replace(/^Bearer /, '')
  if (!apiKey) return res.status(401).send('No API key')
  const key = await apiKeysRepo.findOne({ apiKey })
  if (!key) return res.status(401).send('Invalid API key')
  req.headers['x-tenant-id'] = key.tenantId   // injecte pour le middleware suivant
  next()
})

app.use(expressTenantMiddleware({
  resolver: tenantFromHeader('x-tenant-id'),
}))
```

### Pattern 3 — Next.js App Router avec wrapper

```ts
// lib/with-tenant.ts
import { withTenant, tenantFromSubdomain } from '@mostajs/multitenancy'

const resolver = tenantFromSubdomain({ rootDomain: 'app.com' })

export function withTenantContext<T>(handler: (req: Request) => Promise<T>) {
  return async (req: Request): Promise<T | Response> => {
    return withTenant(req, { resolver }, () => handler(req))
  }
}

// app/api/articles/route.ts
import { withTenantContext } from '@/lib/with-tenant'

export const GET = withTenantContext(async (req) => {
  const articles = await articleRepo.find()
  return Response.json(articles)
})
```

### Pattern 4 — Multi-tenancy par path (admin overview)

Cas où l'admin doit pouvoir naviguer entre tenants :

```ts
// app/api/t/[tenantSlug]/articles/route.ts
import { runWithTenant } from '@mostajs/multitenancy'

export async function GET(req: Request, { params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params
  const session = await getServerSession()
  if (!session?.user.isAdmin) return new Response('Forbidden', { status: 403 })

  const tenant = await tenantsRepo.findOne({ slug: tenantSlug })
  if (!tenant) return new Response('Not found', { status: 404 })

  return runWithTenant({ id: tenant.id, slug: tenant.slug, userId: session.user.id }, async () => {
    const articles = await articleRepo.find()
    return Response.json(articles)
  })
}
```

### Pattern 5 — Background jobs (queue, cron)

Les jobs async (BullMQ, Inngest, cron) tournent **hors d'une requête HTTP** : il faut restaurer le tenant manuellement à partir du payload du job :

```ts
import { runWithTenant } from '@mostajs/multitenancy'

worker.process('article.publish', async (job) => {
  const { tenantId, articleId } = job.data
  return runWithTenant({ id: tenantId }, async () => {
    const article = await articleRepo.findById(articleId)
    if (article) await publishToCDN(article)
  })
})

// Au moment d'enqueuer :
import { requireTenant } from '@mostajs/multitenancy'

async function schedulePublish(articleId: string) {
  const tenant = requireTenant()
  await queue.add('article.publish', { tenantId: tenant.id, articleId })
}
```

### Pattern 6 — Cross-tenant admin (use case rare)

Reporting global, billing, ops monitoring : besoin de voir tous les tenants. Utiliser `runWithoutTenant` (debridge), **avec parcimonie** :

```ts
import { runWithoutTenant } from '@mostajs/multitenancy'

app.get('/admin/global-metrics', async (req, res) => {
  if (!req.user?.isPlatformAdmin) return res.status(403).end()

  const stats = await runWithoutTenant(async () => {
    return {
      totalArticles: await articleRepo.count(),  // pas de filtre tenant
      totalUsers: await userRepo.count(),
    }
  })
  res.json(stats)
})
```

> ⚠️ `runWithoutTenant` désactive le scoping. Tout consumer qui se base sur `requireTenant()` lèvera une erreur. À réserver aux endpoints platform-admin clairement identifiés.

---

## 6. Stratégies de résolution du tenant

### Header HTTP (`x-tenant-id`)

Pour APIs B2B où les clients passent un header explicite.

```ts
tenantFromHeader('x-tenant-id')
// header 'X-Tenant-Id: acme' → { id: 'acme' }
```

### Subdomain

Pour SaaS classiques : chaque tenant a son sous-domaine.

```ts
tenantFromSubdomain()
// 'acme.app.com' → { id: 'acme', slug: 'acme' }

tenantFromSubdomain({ rootDomain: 'app.com' })
// strict mode : ne match que les hosts terminant par .app.com
```

### Path prefix

Pour les routes de type `/t/:tenantSlug/...`.

```ts
tenantFromPath()
// '/t/acme/articles' → { id: 'acme', slug: 'acme' }

tenantFromPath({ prefix: '/workspace/' })
// '/workspace/acme/articles' → { id: 'acme', slug: 'acme' }
```

### Custom resolver

Tout `(req) => TenantInfo | null` est acceptable :

```ts
const tenantFromJwt: TenantResolver = (req: any) => {
  const token = req.headers.authorization?.replace(/^Bearer /, '')
  if (!token) return null
  const payload = jwt.verify(token, JWT_SECRET) as any
  return { id: payload.tenant_id, userId: payload.sub }
}
```

### Combiner plusieurs stratégies

```ts
import { combineResolvers, tenantFromHeader, tenantFromSubdomain } from '@mostajs/multitenancy'

const resolver = combineResolvers(
  tenantFromHeader('x-tenant-id'),       // priorité 1 : header
  tenantFromSubdomain({ rootDomain: 'app.com' }),  // priorité 2 : subdomain
)
```

---

## 7. Tenant policy (allow / deny / custom)

```ts
import { checkTenantPolicy, expressTenantMiddleware, tenantFromSubdomain, getCurrentTenant } from '@mostajs/multitenancy'

const policy: TenantPolicy = {
  blockedIds: ['suspended-tenant-1', 'fraud-2'],
  validate: async (tenant) => {
    const t = await tenantsRepo.findById(tenant.id)
    return t?.status === 'active' && t.subscription?.status === 'paid'
  },
}

app.use(expressTenantMiddleware({
  resolver: tenantFromSubdomain({ rootDomain: 'app.com' }),
}))

// Middleware policy check après resolution
app.use(async (req, res, next) => {
  const tenant = getCurrentTenant()
  if (!tenant) return next()  // already handled by middleware
  if (!(await checkTenantPolicy(tenant, policy))) {
    return res.status(402).send('Subscription suspended — billing.app.com')
  }
  next()
})
```

---

## 8. Patterns avancés

### Tenant + user + role (avec @mostajs/rbac)

```ts
import { getCurrentTenant } from '@mostajs/multitenancy'
import { Role } from '@mostajs/rbac'

const user = await userRepo.findById(req.session.userId)
runWithTenant({ id: tenant.id, userId: user.id, metadata: { roles: user.roles } }, async () => {
  if (!hasRole('admin')) return forbidden()
  // ...
})
```

### Per-tenant feature flags

```ts
import { getCurrentTenant } from '@mostajs/multitenancy'

function isFeatureEnabled(name: string): boolean {
  const t = getCurrentTenant()
  return t?.metadata?.features?.[name] === true
}

if (isFeatureEnabled('video-recording')) {
  // active la feature uniquement pour les tenants payants
}
```

### Per-tenant rate limits

```ts
import { getCurrentTenantId } from '@mostajs/multitenancy'
import rateLimit from 'express-rate-limit'

app.use(rateLimit({
  windowMs: 60_000,
  max: 100,
  keyGenerator: () => getCurrentTenantId() ?? 'anon',
}))
```

### Streaming (SSE, WebSocket)

Les longs streams gardent leur contexte tenant grâce à AsyncLocalStorage — pas besoin de re-injecter à chaque event :

```ts
app.get('/sse/articles', async (req, res) => {
  // déjà dans le contexte tenant via middleware
  res.setHeader('Content-Type', 'text/event-stream')
  const watcher = articleRepo.watchChanges()   // scoped au tenant courant
  for await (const change of watcher) {
    res.write(`data: ${JSON.stringify(change)}\n\n`)
  }
})
```

---

## 9. Tests

```ts
// tests/article-service.test.ts
import { describe, it, expect } from 'vitest'
import { runWithTenant, runWithoutTenant, getCurrentTenantId } from '@mostajs/multitenancy'
import { createMemoryRepository, withTenantScope } from '@mostajs/repository'

describe('tenant scoping', () => {
  const repo = withTenantScope(
    createMemoryRepository({ collection: 'articles' }),
    { getTenantId: getCurrentTenantId },
  )

  it('isole les data par tenant', async () => {
    await runWithTenant({ id: 'acme' }, async () => {
      await repo.save({ id: 'a1', title: 'Acme article', tenantId: 'acme' })
    })
    await runWithTenant({ id: 'globex' }, async () => {
      await repo.save({ id: 'g1', title: 'Globex article', tenantId: 'globex' })
    })

    // Acme ne voit que son article
    await runWithTenant({ id: 'acme' }, async () => {
      const arts = await repo.find()
      expect(arts).toHaveLength(1)
      expect(arts[0].id).toBe('a1')
    })

    // Sans tenant : pas de filter, voit tout
    await runWithoutTenant(async () => {
      const all = await repo.find()
      expect(all).toHaveLength(2)
    })
  })
})
```

---

## 10. Troubleshooting & pièges courants

### `getCurrentTenantId()` retourne `null` dans un handler

**Cause** : appel hors du `run` (le middleware n'est pas passé, ou tu es dans un setTimeout / event listener qui a perdu le contexte async).

**Solution** : vérifier que ton middleware tenant s'exécute bien avant le handler. Pour les listeners (`EventEmitter`, `setImmediate`), capturer le contexte explicitement :
```ts
import { getCurrentTenant, runWithTenant } from '@mostajs/multitenancy'

const tenant = getCurrentTenant()
setTimeout(() => runWithTenant(tenant!, () => { /* ... */ }), 1000)
```

### Data leak entre tenants (panic mode)

**Cause** : un repository sans `withTenantScope`, OU un appel `runWithoutTenant` mal placé, OU une query SQL raw qui contourne le repo.

**Solution audit** :
1. Grep tous les `createRepository(` qui ne sont pas suivis d'un `withTenantScope(`
2. Grep tous les `runWithoutTenant` et les justifier
3. Grep tous les `pg.query` / `mongoose.Model.find` (raw) — doivent inclure `tenantId` explicitement

Convention recommandée : wrapper les exports de repositories dans une factory qui force le scoping :
```ts
function tenantScopedRepo<T extends Entity>(collection: string) {
  return withTenantScope(
    createRepository<T>({ collection }),
    { getTenantId: getCurrentTenantId },
  )
}

// Empêche d'exporter un repo non-scoped par erreur
export const articles = tenantScopedRepo<Article>('articles')
```

### Subdomain resolver matche `www`

Par défaut, `tenantFromSubdomain` filtre `www` (retourne `null`). Si tu veux quand même un tenant nommé `www` (cas tordu), passe par `tenantFromHeader` ou un resolver custom.

### Performance : multiplicité d'indexes

Multi-tenant impose des indexes composés `(tenantId, autres_champs)` plutôt que `(autres_champs)`. Sans ça, les queries scannent toute la collection puis filtrent. À auditer côté DB.

Exemple Mongo :
```js
db.articles.createIndex({ tenantId: 1, status: 1, createdAt: -1 })
```

### Tests parallèles : context partagé ?

Non : `AsyncLocalStorage` est par-chain. Deux tests en parallèle dans Vitest/Jest ont chacun leur contexte. Sûr.

---

## 11. Modules liés

- [`@mostajs/repository`](../mosta-repository) — `withTenantScope` consomme `getCurrentTenantId` de ce module
- [`@mostajs/rbac`](../mosta-rbac) — souvent combiné : tenant + role
- [`@mostajs/auth`](../mosta-auth) — fournit le `userId` qui peuple `tenant.userId`
- [`@mostajs/booking`](../mosta-booking) — exemple de consumer multi-tenant

---

**License** : AGPL-3.0-or-later
**Auteur** : Dr Hamid MADANI <drmdh@msn.com>
