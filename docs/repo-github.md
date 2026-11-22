# Repositorio en GitHub — `juliomark22/prende-rifas`

**Estado:** el repositorio remoto **aún no existe**. El repo local ya está inicializado (rama `main`, ver abajo) y listo para el primer push cuando el remoto exista.

## Qué pasó con el intento de creación

El intento de crear el repositorio con la integración MCP de GitHub falló con **403 "Resource not accessible by integration"**: la integración no tiene permiso para crear repositorios en la cuenta. **No se reintenta la misma llamada** — el fallo es de permisos de la integración, no un error transitorio.

## Qué debe hacer EL DUEÑO (1 minuto)

Crear el repositorio a mano en **github.com/new**:

1. Nombre: `prende-rifas`
2. Visibilidad: **privado**
3. **Sin README inicial**, sin `.gitignore` inicial, sin licencia (el repo local ya trae `README.md` y `.gitignore`; un README inicial en GitHub provocaría un conflicto en el primer push).
4. Crear.

Una vez exista el repo vacío en GitHub, el equipo sube el código con `push_files` (o `git push` desde el repo local) a la rama `main`. Ramas previstas por el plan (§1.3): `main` (producción) y `staging`.

## Repo local (ya listo)

- Ruta: `~/workspace/rifa-sistema/prende-rifas/`
- Inicializado con `git init -b main` (S0, 21 nov 2026).
- **Sin commits todavía**: el primer commit se hace cuando el backend y el frontend reporten, según EJECUCION-v2.2.md.
- `.gitignore` verificado: cubre `node_modules/`, `.next/`, `.env*`, `*.db`, `dev.db`, `*.tsbuildinfo`, `.vercel`, `coverage/`. El `.env` real, las bases de datos locales y los artefactos de build **no** aparecen como trackeables (verificado con `git status`).

## Qué NO va al repo remoto

- `.env` (secretos reales) ni ningún `*.db` / `dev.db`.
- Credenciales de pasarelas (Azul, CardNet, PayPal): solo las entrega el dueño por Secure Vault; nunca en el repo ni en `.env.example` (que solo lleva placeholders).
