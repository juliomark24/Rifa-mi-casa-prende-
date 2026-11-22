/** Formato de moneda, fechas y porcentajes (español). Etiquetas v2.2. */

export function formatMoney(amount: number, currency = "DOP"): string {
  try {
    return new Intl.NumberFormat("es-DO", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString("es-DO")}`;
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-DO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-DO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

export function percentSoldOf(r: { soldCount?: number; percentSold?: number; totalTickets: number }): number {
  if (typeof r.percentSold === "number") return Math.round(r.percentSold);
  if (typeof r.soldCount === "number" && r.totalTickets > 0) {
    return Math.round((r.soldCount / r.totalTickets) * 100);
  }
  return 0;
}

export const STATUS_LABELS: Record<string, string> = {
  // Rifas (11 estados, plan §2.7)
  BORRADOR: "Borrador",
  PENDIENTE_APROBACION: "Pendiente de aprobación",
  PROGRAMADA: "Programada",
  ACTIVA: "Activa",
  PAUSADA: "Pausada",
  AGOTADA: "Agotada",
  CERRADA: "Cerrada",
  EN_SORTEO: "En sorteo",
  GANADOR_PUBLICADO: "Ganador publicado",
  FINALIZADA: "Finalizada",
  CANCELADA: "Cancelada",
  // Boletos
  DISPONIBLE: "Disponible",
  RESERVADO: "Reservado",
  VENDIDO: "Vendido",
  ANULADO: "Anulado",
  // Pedidos
  PENDIENTE: "Pendiente",
  CONFIRMADO: "Confirmado",
  FALLIDO: "Fallido",
  EXPIRADO: "Expirado",
  REEMBOLSADO: "Reembolsado",
  DISPUTADO: "Disputado",
  // Pagos
  APROBADO: "Aprobado",
  CONTRACARGO: "Contracargo",
  // Países
  CONFIGURACION: "Configuración",
  REVISION: "Revisión",
  ACTIVO: "Activo",
  // Caso del ganador (7 estados, plan §2.15)
  PENDIENTE_CONTACTO: "Pendiente de contacto",
  CONTACTADO: "Contactado",
  VERIFICACION: "Verificación",
  PREMIO_ACEPTADO: "Premio aceptado",
  ENTREGA_COORDINADA: "Entrega coordinada",
  ENTREGADO: "Entregado",
  CASO_CERRADO: "Caso cerrado",
  // Riesgo / fraude (plan §2.14)
  NORMAL: "Normal",
  RETENIDO: "Retenido",
  BLOQUEADO: "Bloqueado",
  // Soporte (plan §2.17)
  ABIERTO: "Abierto",
  EN_REVISION: "En revisión",
  ESPERANDO_CLIENTE: "Esperando al cliente",
  RESUELTO: "Resuelto",
  CERRADO: "Cerrado",
  // Retiros / comisiones
  SOLICITADO: "Solicitado",
  PAGADO: "Pagado",
  RECHAZADO: "Rechazado",
  REQUESTED: "Solicitado",
  PAID: "Pagado",
  REJECTED: "Rechazado",
  // Notificaciones (ENTREGADO y FALLIDO ya definidos arriba)
  EN_COLA: "En cola",
  ENVIADO: "Enviado",
  QUEUED: "En cola",
  SENT: "Enviado",
  DELIVERED: "Entregado",
  FAILED: "Fallido",
  // Roles
  SUPERADMIN: "Superadministrador",
  ADMIN_RIFAS: "Administrador de rifas",
  FINANZAS: "Finanzas",
  AUDITOR: "Auditor",
  MARKETING: "Marketing",
  AFILIADO: "Afiliado",
  CLIENTE: "Cliente",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  MANUAL_TRANSFER: "Transferencia manual",
  PAYPAL: "PayPal",
  AZUL_CARD: "Tarjeta (Azul)",
  CARDNET_CARD: "Tarjeta (CardNet)",
};

export function paymentMethodLabel(code: string): string {
  return PAYMENT_METHOD_LABELS[code] ?? code;
}

export const COUNTRY_CLASS_LABELS: Record<string, string> = {
  A: "A — Activable por configuración",
  B: "B — Necesita nueva integración",
  C: "C — Pendiente de revisión legal/comercial",
};

export function countryClassLabel(cls: string | null | undefined): string {
  if (!cls) return "Sin clasificar";
  return COUNTRY_CLASS_LABELS[cls] ?? `Clase ${cls}`;
}

export const SUPPORT_TYPE_LABELS: Record<string, string> = {
  PAGO_SIN_BOLETO: "Pagué y no recibí mi boleto",
  CONSULTA_BOLETO: "No puedo consultar mi boleto",
  PAGO_RECHAZADO: "Mi pago fue rechazado",
  PROBLEMA_COMPRA: "Tengo un problema con mi compra",
  DEVOLUCION: "Quiero solicitar una devolución",
  DUDA_GANADOR: "Tengo dudas sobre el ganador",
  OTRO: "Otro",
};

export function supportTypeLabel(type: string | null | undefined): string {
  if (!type) return "—";
  return SUPPORT_TYPE_LABELS[type] ?? type;
}
