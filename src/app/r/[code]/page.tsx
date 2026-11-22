export const instant = false;

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Link de referido /r/[code]: registra el clic y redirige a la home.
 * Guarda la cookie pr_ref (30 días) para atribuir la compra
 * (atribución por ?ref=CODIGO o cookie pr_ref; ventana 7 días, último clic).
 *
 * TODO (hueco del contrato): el contrato v2.2 dice que GET /api/r/[code]
 * "(página, no API) registra clic de afiliado y redirige" — es decir, esta
 * misma página ES el registro del clic, pero no define cómo se persiste
 * ese clic (no hay endpoint POST). Esta página solo guarda la cookie de
 * atribución; el backend deberá registrar el clic al servir esta ruta o
 * exponer el endpoint. No se inventa una llamada que no existe.
 */
export default async function ReferralPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const clean = decodeURIComponent(code).trim().toUpperCase();

  // Cookie de atribución (legible desde el cliente para el formulario de compra).
  const store = await cookies();
  store.set("pr_ref", clean, {
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    sameSite: "lax",
  });

  redirect("/");
}
