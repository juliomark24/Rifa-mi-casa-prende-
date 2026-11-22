// Tipos del frontend según API-CONTRACT-v2.2.md (fuente de verdad).
// Enums y formas de respuesta copiados del contrato; donde el contrato no
// define la forma exacta se marca con TODO y los campos son opcionales.

// ---------------------------------------------------------------- enums ---
export type Role =
  | "SUPERADMIN"
  | "ADMIN_RIFAS"
  | "FINANZAS"
  | "AUDITOR"
  | "MARKETING"
  | "AFILIADO"
  | "CLIENTE";

/** Roles con acceso al panel /admin (el permiso real lo verifica el backend). */
export const ADMIN_ROLES: Role[] = ["SUPERADMIN", "ADMIN_RIFAS", "FINANZAS", "AUDITOR", "MARKETING"];

export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && (ADMIN_ROLES as string[]).includes(role);
}

export type RaffleStatus =
  | "BORRADOR"
  | "PENDIENTE_APROBACION"
  | "PROGRAMADA"
  | "ACTIVA"
  | "PAUSADA"
  | "AGOTADA"
  | "CERRADA"
  | "EN_SORTEO"
  | "GANADOR_PUBLICADO"
  | "FINALIZADA"
  | "CANCELADA";

/** Transiciones permitidas de la máquina de 11 estados (plan §2.7). */
export const RAFFLE_NEXT_STATES: Partial<Record<RaffleStatus, RaffleStatus[]>> = {
  BORRADOR: ["PENDIENTE_APROBACION", "CANCELADA"],
  PENDIENTE_APROBACION: ["PROGRAMADA", "BORRADOR", "CANCELADA"],
  PROGRAMADA: ["ACTIVA", "CANCELADA"],
  ACTIVA: ["PAUSADA", "AGOTADA", "CERRADA", "CANCELADA"],
  PAUSADA: ["ACTIVA", "CANCELADA"],
  AGOTADA: ["CERRADA", "CANCELADA"],
  CERRADA: ["EN_SORTEO", "CANCELADA"],
  EN_SORTEO: ["GANADOR_PUBLICADO"],
  GANADOR_PUBLICADO: ["FINALIZADA"],
  FINALIZADA: [],
  CANCELADA: [],
};

export type TicketStatus = "DISPONIBLE" | "RESERVADO" | "VENDIDO" | "ANULADO";
export type OrderStatus = "PENDIENTE" | "CONFIRMADO" | "FALLIDO" | "EXPIRADO" | "REEMBOLSADO" | "DISPUTADO";
export type PaymentStatus = "PENDIENTE" | "APROBADO" | "FALLIDO" | "REEMBOLSADO" | "CONTRACARGO";
export type PaymentMethodCode = "MANUAL_TRANSFER" | "PAYPAL" | "AZUL_CARD" | "CARDNET_CARD";
export type CountryStatus = "BORRADOR" | "CONFIGURACION" | "REVISION" | "ACTIVO";
/** Clasificación A/B/C del plan §2.9: A = activable por configuración,
 *  B = necesita nueva integración, C = pendiente de revisión legal/comercial. */
export type CountryClass = "A" | "B" | "C";
export type WinnerCaseStatus =
  | "PENDIENTE_CONTACTO"
  | "CONTACTADO"
  | "VERIFICACION"
  | "PREMIO_ACEPTADO"
  | "ENTREGA_COORDINADA"
  | "ENTREGADO"
  | "CASO_CERRADO";

/** Flujo del caso del ganador (plan §2.15): lineal, un paso a la vez.
 * El backend (lib/winner.ts) rechaza saltos y retrocesos con 409; el
 * frontend solo ofrece el siguiente estado válido (S9-int). */
export const WINNER_FLOW: WinnerCaseStatus[] = [
  "PENDIENTE_CONTACTO",
  "CONTACTADO",
  "VERIFICACION",
  "PREMIO_ACEPTADO",
  "ENTREGA_COORDINADA",
  "ENTREGADO",
  "CASO_CERRADO",
];

export const WINNER_NEXT: Record<WinnerCaseStatus, WinnerCaseStatus | null> = {
  PENDIENTE_CONTACTO: "CONTACTADO",
  CONTACTADO: "VERIFICACION",
  VERIFICACION: "PREMIO_ACEPTADO",
  PREMIO_ACEPTADO: "ENTREGA_COORDINADA",
  ENTREGA_COORDINADA: "ENTREGADO",
  ENTREGADO: "CASO_CERRADO",
  CASO_CERRADO: null,
};

/** Procedimientos de las bases (plan §2.15): se registran sin avanzar el
 * caso; el caso permanece abierto hasta la resolución del responsable. */
export const WINNER_OUTCOMES = ["NO_ELEGIBLE", "RENUNCIA", "SIN_RESPUESTA", "ENTREGA_IMPOSIBLE"] as const;
export type WinnerOutcome = (typeof WINNER_OUTCOMES)[number];
export type RiskStatus = "NORMAL" | "REVISION" | "RETENIDO" | "APROBADO" | "BLOQUEADO";
export type SupportTicketStatus = "ABIERTO" | "EN_REVISION" | "ESPERANDO_CLIENTE" | "RESUELTO" | "CERRADO";
export type SupportTicketType =
  | "PAGO_SIN_BOLETO"
  | "CONSULTA_BOLETO"
  | "PAGO_RECHAZADO"
  | "PROBLEMA_COMPRA"
  | "DEVOLUCION"
  | "DUDA_GANADOR"
  | "OTRO";

/**
 * Estado de integración de un proveedor de pago (UI de /admin/paises).
 * TODO (hueco del contrato): el contrato v2.2 no define un endpoint de
 * estado de proveedor ni de prueba en sandbox; el estado se deriva de
 * GET /api/admin/payment-methods (método existe/habilitado) y el entorno
 * se guarda por PATCH sobre el método. Ver PaymentIntegrations.tsx.
 */
export interface ProviderIntegration {
  provider: string;
  name: string;
  type: string;
  status: string;
  sandboxMode: boolean;
  credentialsConfigured: boolean;
  credentialKeys: string[];
  authorizedForRaffles: boolean;
  lastSandboxTestAt?: string | null;
  lastSandboxTestPassed?: boolean | null;
  verifiedAt?: string | null;
  gate: { ok: boolean; reasons: string[] };
}

export interface ReconciliationCase {
  id: string;
  provider: string;
  period?: string | null;
  status: "ABIERTO" | "EN_REVISION" | "RESUELTO" | string;
  detail?: Record<string, unknown> | null;
  amount?: number | null;
  currency?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: { id: string; name: string; email: string } | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface LedgerBalances {
  currency: string;
  ventas: number;
  reembolsos: number;
  contracargos: number;
  costos: number;
  comisionesNeto: number;
  retiros: number;
  reservas: number;
  ajustesOtros: number;
  neto: number;
  comisionesPorEstado: { PENDING: number; RETAINED: number; AVAILABLE: number; PAID: number; ADJUSTED: number };
  comisionesComprometidas: number;
  comisionesDisponibles: number;
  comisionesPagadas: number;
  enDisputaPedidos: number;
  movimientos: number;
}

export interface LedgerMovement {
  id: string;
  type: string;
  amount: number;
  currency: string;
  refType: string;
  refId: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export type NotificationStatus = "EN_COLA" | "ENVIADO" | "ENTREGADO" | "FALLIDO" | "PENDIENTE" | "SENT" | "DELIVERED" | "FAILED" | "QUEUED";

// ------------------------------------------------------------- respuestas ---
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  referralCode?: string | null;
}

export interface Raffle {
  id: string;
  title: string;
  description: string;
  prize: string;
  imageUrl?: string | null;
  country: string;
  currency: string;
  ticketPrice: number;
  totalTickets: number;
  drawAt: string;
  status: RaffleStatus;
  rules?: string | null;
  termsVersionId?: string | null;
  licenseNumber?: string | null;
  soldCount?: number;
  percentSold?: number;
  availableCount?: number;
  soldNumbers?: number[];
  /** Números RESERVADOS por otros compradores (detalle, contrato v2.2). */
  reservedNumbers?: number[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Ticket {
  id: string;
  number: number;
  code: string;
  status: TicketStatus;
  raffleId: string;
  orderId?: string | null;
  buyerName?: string | null;
  buyerEmail?: string | null;
  buyerPhone?: string | null;
  createdAt?: string;
  raffle?: Raffle | null;
  order?: Order | null;
}

export interface Order {
  id: string;
  code: string;
  raffleId: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone?: string | null;
  totalAmount: number;
  currency: string;
  status: OrderStatus;
  paymentMethodCode: PaymentMethodCode | string;
  paymentStatus?: PaymentStatus | string;
  affiliateCode?: string | null;
  createdAt?: string;
  updatedAt?: string;
  tickets?: Ticket[];
  raffle?: Raffle | null;
}

export interface Reservation {
  reservationId: string;
  expiresAt: string;
  numbers: number[];
}

export interface PaymentInstructions {
  /** Forma real del backend (createOrder): método, etiqueta, detalles
    (banco/cuenta), referencia (código de orden), monto y moneda. */
  method?: string;
  label?: string;
  details?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  [key: string]: unknown;
}

export interface PurchaseResult {
  order: Order;
  tickets?: Ticket[];
  paymentInstructions?: PaymentInstructions | string | null;
}

export interface PaymentMethod {
  id: string;
  country: string;
  currency: string;
  code: PaymentMethodCode | string;
  label: string;
  details?: string | null;
  enabled: boolean;
  provider?: string | null;
  environment?: "sandbox" | "production" | string | null;
  createdAt?: string;
}

export interface PublicPaymentMethod {
  code: PaymentMethodCode | string;
  label: string;
  details?: string | null;
  provider?: string | null;
  currency?: string;
}

/** Resultado público verificable del sorteo (commit-reveal). */
export interface Draw {
  drawId: string;
  raffleId: string;
  commitment: string;
  seed: string | null;
  hashElegibles: string;
  totalElegibles: number;
  winnerTicketNumber: number;
  winnerTicketCode: string;
  algorithm: string;
  executedAt: string;
  // Campos tolerados de formas anteriores (por si el backend los incluye).
  hash?: string;
  winningTicket?: Ticket | null;
  createdAt?: string;
}

export interface PublicWinner {
  raffleId: string;
  raffleTitle?: string;
  prize?: string;
  winnerTicketNumber: number;
  winnerTicketCode?: string;
  winnerName?: string | null;
  executedAt?: string;
  drawAt?: string;
  drawId?: string;
}

export interface VerifyResult {
  ticket?: Ticket;
  raffle?: Raffle;
  isWinner?: boolean;
  winner?: boolean;
  won?: boolean;
}

/**
 * País — flujo "Agregar país", 16 campos (plan §2.9). Los campos de texto
 * libre (reglas, legal, notificaciones, reembolsos) se guardan como texto;
 * si el backend los estructura distinto, la forma exacta es un hueco del
 * contrato (no hay ejemplo de respuesta para GET /api/admin/countries).
 */
export interface Country {
  id: string;
  name: string;
  code: string;
  flag?: string | null;
  /** Código ISO 4217 (la API devuelve `currencyCode`, no `currency`). */
  currencyCode: string;
  currency?: string | null;
  currencySymbol?: string | null;
  currencyFormat?: string | null;
  /** Idiomas disponibles (la API devuelve `availableLanguages`). */
  availableLanguages?: string[] | string | null;
  languages?: string[] | string | null;
  defaultLanguage?: string | null;
  timezone: string;
  dateFormat?: string | null;
  timeFormat?: string | null;
  allowedCountries?: string[] | string | null;
  blockedCountries?: string[] | string | null;
  legalConfig?: string | Record<string, unknown> | null;
  notificationConfig?: string | Record<string, unknown> | null;
  refundRules?: string | Record<string, unknown> | null;
  classification?: CountryClass;
  status: CountryStatus;
  legalVerified?: boolean;
  providerVerified?: boolean;
  gate?: { ok: boolean; reasons: string[] } | null;
  allowsRaffles?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface WinnerCase {
  id: string;
  raffleId: string;
  raffleTitle?: string | null;
  ticketNumber?: number | null;
  ticketCode?: string | null;
  buyerName?: string | null;
  buyerEmail?: string | null;
  status: WinnerCaseStatus;
  /** Evidencia de entrega (JSON: fotos/acta + fecha + responsable). */
  evidence?: string | Record<string, unknown> | null;
  /** Registro de contactos [{at, channel, note?}] (la API no devuelve
    contactedAt/contactChannel sueltos). */
  contactLog?: Array<{ at: string; channel: string; note?: string }> | null;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SupportTicket {
  id: string;
  /** Número de caso único (TKT-000123); la API lo devuelve como `number`. */
  number?: string | null;
  caseNumber?: string | null;
  subject?: string;
  type?: SupportTicketType | string;
  description?: string | null;
  status: SupportTicketStatus;
  priority?: string | null;
  /** Responsable: la API devuelve `ownerId` + `owner` {name, email};
    `assignee` es el campo que el PATCH acepta (id de admin o null). */
  ownerId?: string | null;
  owner?: { id: string; name: string; email: string } | null;
  assignee?: string | null;
  orderId?: string | null;
  orderCode?: string | null;
  order?: { id: string; code: string; status: string; totalAmount: number; currency: string; buyerEmail: string } | null;
  buyerName?: string | null;
  buyerEmail?: string | null;
  dueAt?: string | null;
  slaHours?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface FraudCase {
  id: string;
  type?: string | null;
  subject?: string | null;
  riskStatus: RiskStatus;
  reason?: string | null;
  rule?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  reviewedBy?: string | null;
  decision?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface NotificationItem {
  id: string;
  event?: string | null;
  channel?: string | null;
  recipient?: string | null;
  status: NotificationStatus | string;
  attempts?: number | null;
  lastError?: string | null;
  createdAt?: string;
  sentAt?: string | null;
  deliveredAt?: string | null;
}

export interface JobRun {
  id?: string;
  name: string;
  status?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  result?: string | null;
  error?: string | null;
  retries?: number | null;
}

/** Salud del sistema. Forma flexible: el contrato no fija los campos. */
export interface SystemHealth {
  status?: string | null;
  database?: string | Record<string, unknown> | null;
  queues?: unknown;
  jobs?: JobRun[] | Record<string, unknown> | null;
  backups?: unknown;
  alerts?: Array<string | Record<string, unknown>> | null;
  lastBackupAt?: string | null;
  checkedAt?: string | null;
  [key: string]: unknown;
}

export interface AffiliateStats {
  referralCode?: string;
  referralLink?: string;
  clicks: number;
  sales: number;
  commissionPending: number;
  commissionRetained?: number;
  commissionAvailable?: number;
  commissionPaid?: number;
  balance: number;
  currency?: string;
}

export interface AffiliateSale {
  id: string;
  orderId?: string | null;
  orderCode?: string | null;
  ticketId?: string | null;
  amount: number;
  commission?: number | null;
  status: string;
  createdAt?: string;
  order?: Order | null;
}

export interface Withdrawal {
  id: string;
  affiliateId: string;
  amount: number;
  status: string;
  createdAt?: string;
  affiliate?: { id: string; name: string; email: string } | null;
}

/** Resumen de afiliado tal como lo devuelve GET /api/admin/affiliates
 * (getAffiliateSummary): comisiones por estado y saldo derivado.
 * S9-int: la página leía `commissionPending`/`balance` (número) e `id`,
 * pero la API devuelve `commissions: {pending, retained, available,
 * paid, adjusted}`, `balance: {available, ...}` y `affiliateId`. */
export interface AdminAffiliate {
  affiliateId: string;
  id?: string;
  name: string;
  email: string;
  referralCode?: string | null;
  referralLink?: string | null;
  clicks?: number;
  sales?: number;
  salesTotal?: number;
  currency?: string;
  balance?: { available?: number; availableForNewWithdrawal?: number; pending?: number; retained?: number; paid?: number } | number;
  commissions?: { pending?: number; retained?: number; available?: number; paid?: number; adjusted?: number };
  riskStatus?: string | null;
  createdAt?: string;
}

export interface AdminStats {
  totalSales?: number;
  totalRevenue?: number;
  totalOrders?: number;
  pendingOrders?: number;
  totalRaffles?: number;
  totalTicketsSold?: number;
  percentSold?: number;
  totalAffiliates?: number;
  refunds?: number;
  chargebacks?: number;
  commissions?: number | Record<string, unknown>;
  profit?: number;
  conversionRate?: number;
  salesRate?: number | string;
  alerts?: Array<string | Record<string, unknown>>;
  [key: string]: unknown;
}

export interface PagedResponse<T> {
  data: T[];
  page: number;
  total: number;
}

export interface ApiError {
  error: string;
}

/** Extrae el mensaje de error de una respuesta JSON {error: "..."}. */
export async function readApiError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as ApiError;
    if (data && typeof data.error === "string" && data.error) return data.error;
  } catch {
    // cuerpo no-JSON
  }
  return `Error ${res.status}: ${res.statusText || "respuesta inesperada del servidor"}`;
}

/** Mensaje de error legible a partir de un cuerpo JSON ya leído. */
export function apiErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && typeof (data as ApiError).error === "string") {
    return (data as ApiError).error;
  }
  return fallback;
}

/** Normaliza una respuesta de lista: array directo o {data|items|...: []}. */
export function asArray<T>(data: unknown, key?: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (key && Array.isArray(obj[key])) return obj[key] as T[];
    for (const k of ["data", "items", "results"]) {
      if (Array.isArray(obj[k])) return obj[k] as T[];
    }
  }
  return [];
}

/** Clave única por intento de compra/pago (idempotencia, contrato). */
export function newIdempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
