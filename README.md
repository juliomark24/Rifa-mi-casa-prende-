# PRENDE RIFAS

Plataforma web de rifas digitales (software completo que vive en una página web, sin app móvil en v1): cualquier persona puede ver rifas, comprar boletos con métodos de pago de su país, verificar si ganó, y los afiliados ganan el 10% por cada boleto vendido con su enlace. El dueño lo controla todo desde un panel de administración.

> **Producto de producción con dinero real. No demo, no simulación.**
> Documento maestro y especificación funcional congelada: [`../plan-tecnico-v2.md`](../plan-tecnico-v2.md) (v2.2, aprobada por el dueño el 21 nov 2026). Ejecución por subfases: [`../EJECUCION-v2.2.md`](../EJECUCION-v2.2.md). Contrato API: [`./API-CONTRACT-v2.2.md`](./API-CONTRACT-v2.2.md). Lo que solo el dueño puede hacer (legal, RNC, dominio, primera rifa): [`../docs/fase0-dueno.md`](../docs/fase0-dueno.md).

## Stack

| Capa | Tecnología |
|---|---|
| Aplicación | Next.js 16 (App Router, TypeScript) full-stack |
| Base de datos | PostgreSQL (producción); SQLite solo para desarrollo local |
| ORM | Prisma (esquema versionado, migraciones) |
| Autenticación | JWT con `jose`, cookie httpOnly `pr_session`, bcryptjs (12 rounds) |
| Pagos | Adaptador `PaymentProvider` (una interfaz; un adaptador por pasarela) |
| Correo | Proveedor transaccional (Resend o similar; opcional en Fase 1) |
| Validación | zod en todos los endpoints |

## Estado del proyecto

Fase 1 en ejecución por subfases (S0–S10, ver `EJECUCION-v2.2.md`). El código actual es el esqueleto v1 preservado: páginas del frontend + esquema Prisma v1, **sin capa API todavía** (`src/app/api/` y `src/lib/` no existen). La construcción v2 reutiliza lo que sirva y reescribe o añade todo lo que falta (reservas con expiración, ledger inmutable, idempotencia, sorteo commit-reveal, 2FA, RBAC, 11 estados de rifa).

## Pagos — proveedores preintegrados y su estado

La gestión de integraciones de pago se hace **desde el panel de control admin** (sección Configuración Internacional) para no detener la operación — aclaración del dueño, 21 nov 2026 17:39 AST. Los proveedores preintegrados desde el inicio son:

| Proveedor | Estado en Fase 1 |
|---|---|
| Transferencia manual (verificación del admin) | **Operativo** — método de respaldo desde el día uno |
| PayPal | Skeleton NO operativo — 503 `NOT_CONFIGURED` hasta credenciales reales + verificación |
| Azul (Banco Popular, RD) | Skeleton NO operativo — 503 hasta afiliación (RNC + cuenta comercial + homologación) |
| CardNet (Banreservas, RD) | Skeleton NO operativo — 503 hasta afiliación (RNC + cuenta comercial + homologación) |
| Mercado Pago | Fase 2 (se evalúa; no está en Fase 1) |

**Stripe NO es proveedor para RD** (verificado 21 nov 2026: Stripe no abre cuentas a empresas registradas en República Dominicana). Está instalado como dependencia del esqueleto v1, pero el camino crítico no se construye sobre Stripe.

**Regla 6 del plan: ninguna pasarela es operativa hasta verificar su integración real, su autorización para la actividad de rifas y su conciliación.** Una pasarela completamente nueva sigue necesitando su adaptador desarrollado una vez (distinción A/B/C del plan §2.2 sin cambios); después de integrada, se configura y activa desde el panel.

## Cómo correr en local

```bash
npm install
cp .env.example .env        # y rellena los valores (ver .env.example)
npx prisma generate
npx prisma db push          # desarrollo local (SQLite)
npm run seed                # crea el superadmin inicial (cuando exista el seed, S1)
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000).

> El seed y los scripts `seed`/`test` se añaden en las subfases S1 (datos) y S4–S10 (pruebas). Si un script no existe todavía, es porque su subfase no ha llegado, no porque falte instalar nada.

## Variables de entorno

Copia `.env.example` a `.env` y rellena solo lo que tengas. **Nunca commitees el `.env` real** (está en `.gitignore`, junto con `*.db`).

| Variable | Para qué | Obligatoria |
|---|---|---|
| `DATABASE_URL` | Conexión a la base de datos (`file:./dev.db` en local; PostgreSQL en producción) | Sí |
| `JWT_SECRET` | Firmar JWT de sesión. Generar con `openssl rand -base64 32`. Sin fallback débil en producción | Sí |
| `NEXT_PUBLIC_APP_URL` | URL pública de la app | Sí |
| `COMMISSION_RATE` | Comisión de afiliados en % (def. 10) | No (def. 10) |
| `RESERVATION_MINUTES` | Duración de la reserva de boletos (def. 10) | No (def. 10) |
| `MIN_WITHDRAWAL` | Retiro mínimo de afiliados (def. RD$500) | No (def. 500) |
| `RETENTION_DAYS` | Retención de comisiones en días (def. 7) | No (def. 7) |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_WEBHOOK_ID` | PayPal (solo cuando el dueño las entregue por Secure Vault) | No en Fase 1 |
| `AZUL_MERCHANT_ID` / `AZUL_API_KEY` / `AZUL_API_SECRET` | Azul (solo tras afiliación) | No en Fase 1 |
| `CARDNET_MERCHANT_ID` / `CARDNET_API_KEY` / `CARDNET_API_SECRET` | CardNet (solo tras afiliación) | No en Fase 1 |
| `RESEND_API_KEY` | Correo transaccional (opcional en Fase 1) | No |
| `SEED_ADMIN_PASSWORD` | Contraseña del superadmin creado por el seed (solo desarrollo) | Solo para seed |

## Estructura de carpetas

```
prende-rifas/
├── src/
│   ├── app/            # Páginas (App Router) + API REST en src/app/api/
│   ├── components/     # Componentes React compartidos
│   └── lib/            # Servicios y módulos por dominio (auth, pagos,
│                       # ledger, sorteos, jobs...) — se crea en S1/S2
├── prisma/
│   ├── schema.prisma   # Esquema v2.2 completo (S1)
│   └── migrations/     # Migraciones versionadas
├── tests/              # Pruebas automatizadas (P1–P28 del plan §5.1)
├── docs/               # Documentación operativa del sistema
│   ├── recuperacion-admin-2fa.md
│   ├── jobs.md
│   └── repo-github.md
├── API-CONTRACT-v2.2.md  # Contrato API backend ↔ frontend (fuente: plan v2.2)
├── .env.example        # Plantilla de variables (sin valores reales)
└── AGENTS.md           # Reglas de trabajo del plan v2.2
```

Los documentos maestros viven fuera de este repo, en `~/workspace/rifa-sistema/`: `plan-tecnico-v2.md`, `EJECUCION-v2.2.md`, `levantamiento-rifamicasa-2026-11-21.md` (auditoría del repo viejo) y `docs/fase0-dueno.md`. **Nadie los modifica** salvo el coordinador con aprobación del dueño.

## Cómo correr tests

```bash
npm test               # suite completa (cuando exista, S4 en adelante)
npm run test:watch     # modo interactivo
```

Las 28 pruebas obligatorias P1–P28 están definidas en el plan §5.1 (concurrencia de compra, idempotencia, conciliación, sorteo verificable, recuperación, fraude, ganador y entrega, notificaciones, soporte, bases versionadas, moneda, control de cambios). Ninguna fase se da por terminada sin sus pruebas superadas y documentadas (regla 7: no basta la interfaz visual).

## Reglas que no se negocian

- **Dinero en enteros** (unidades mayores de la moneda). Nunca floats para dinero.
- **zod en todos los endpoints.** El rol nunca viene del cliente (viene de la sesión).
- **Secretos solo por variables de entorno.** `.env` y `*.db` nunca se commitean.
- **Un boleto no se marca vendido hasta que el pago esté confirmado.**
- **Especificación congelada (plan v2.2):** no se agregan funcionalidades importantes. Si un problema técnico obliga a cambiar una decisión de arquitectura: DETENERSE, explicar, presentar alternativa y ESPERAR aprobación (regla 8).
- **Lanzamiento solo en República Dominicana.** Sin licencia de Hacienda ni registro en Pro Consumidor no se cobra dinero real (ver `docs/fase0-dueno.md`).

Ver las reglas completas de trabajo en [`AGENTS.md`](./AGENTS.md).
