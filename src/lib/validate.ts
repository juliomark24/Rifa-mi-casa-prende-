// Validación con zod en TODOS los endpoints (regla de código v2.2).
import { z } from "zod";
import { badRequest } from "./errors";

export const emailSchema = z.string().trim().toLowerCase().email("Email inválido");
export const passwordSchema = z
  .string()
  .min(8, "La contraseña debe tener al menos 8 caracteres")
  .max(128, "La contraseña es demasiado larga");

export const registerSchema = z.object({
  name: z.string().trim().min(2, "El nombre es obligatorio").max(120),
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "La contraseña es obligatoria"),
});

export const login2faSchema = z.object({
  email: emailSchema,
  code: z.string().trim().min(6).max(12), // TOTP 6 dígitos o backup code (11 con guion)
});

export const twoFactorVerifySchema = z.object({
  code: z.string().trim().min(6).max(10),
});

export const twoFactorDisableSchema = z.object({
  password: z.string().min(1, "La contraseña es obligatoria"),
  code: z.string().trim().min(6).max(10),
});

export const recoverSchema = z.object({
  email: emailSchema,
});

export const recoverCompleteSchema = z.object({
  email: emailSchema,
  code: z.string().trim().min(6).max(6),
  newPassword: passwordSchema,
});

export const providerPatchSchema = z.object({
  sandboxMode: z.boolean().optional(),
  credentialsRef: z.string().trim().max(200).nullable().optional(),
  // Credenciales desde el panel: solo campos no vacíos; se cifran y nunca
  // se devuelven. Se fusionan con las ya guardadas (ver registry.ts).
  credentials: z.record(z.string(), z.unknown()).optional(),
  authorizedForRaffles: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  // Solo se permite desactivar por PATCH (a NO_OPERATIVO). Activar exige
  // el gate de POST .../activate (regla 6). Cualquier otro valor → 400.
  status: z.enum(["NO_OPERATIVO"]).optional(),
});

// Métodos de pago (S9-int: las rutas no existían aunque el contrato y el
// frontend las usaban). El código de método es ÚNICO en el schema: un
// método es global y su habilitación por país vive en
// CountryPaymentConfig; POST crea el método y su configuración para el
// país indicado. El proveedor se resuelve por código de método.
export const paymentMethodCodeSchema = z.enum(["MANUAL_TRANSFER", "PAYPAL", "AZUL_CARD", "CARDNET_CARD"]);

export const paymentMethodCreateSchema = z.object({
  country: z.string().trim().length(2, "El código ISO debe tener 2 letras").toUpperCase(),
  currency: z.string().trim().length(3, "La moneda debe tener 3 letras").toUpperCase(),
  code: paymentMethodCodeSchema,
  label: z.string().trim().min(2, "La etiqueta es obligatoria").max(120),
  details: z.string().trim().max(2000).optional(),
  enabled: z.boolean().optional(),
});

export const paymentMethodPatchSchema = z.object({
  label: z.string().trim().min(2, "La etiqueta es obligatoria").max(120).optional(),
  details: z.string().trim().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
});

export const supportTicketCreateSchema = z.object({
  type: z.enum([
    "PAGO_SIN_BOLETO",
    "CONSULTA_BOLETO",
    "PAGO_RECHAZADO",
    "PROBLEMA_COMPRA",
    "DEVOLUCION",
    "DUDA_GANADOR",
    "OTRO",
  ]),
  buyerEmail: emailSchema,
  orderCode: z.string().trim().max(32).optional(),
  message: z.string().trim().min(10, "Describe tu problema (mín. 10 caracteres)").max(5000),
});

export const affiliateClickSchema = z.object({
  code: z.string().trim().min(1).max(32),
  raffleId: z.string().trim().max(64).optional(),
});

export const winnerPatchSchema = z.object({
  status: z.enum([
    "PENDIENTE_CONTACTO",
    "CONTACTADO",
    "VERIFICACION",
    "PREMIO_ACEPTADO",
    "ENTREGA_COORDINADA",
    "ENTREGADO",
    "CASO_CERRADO",
  ]),
  evidence: z.unknown().optional(),
  note: z.string().trim().max(5000).optional(),
});

export const supportTicketPatchSchema = z.object({
  status: z.enum(["ABIERTO", "EN_REVISION", "ESPERANDO_CLIENTE", "RESUELTO", "CERRADO"]),
  assignee: z.string().trim().max(64).nullable().optional(),
  note: z.string().trim().max(5000).optional(),
});

export const fraudPatchSchema = z.object({
  riskStatus: z.enum(["NORMAL", "REVISION", "RETENIDO", "APROBADO", "BLOQUEADO"]),
  decision: z.string().trim().max(2000).optional(),
  note: z.string().trim().max(5000).optional(),
});

export const termsCreateSchema = z.object({
  raffleId: z.string().trim().min(1),
  content: z.string().trim().min(10, "El texto de las bases es obligatorio").max(100000),
});

// ---------------------------------------------------------------- S3: rifas (plan §2.7)
export const raffleStatusEnum = z.enum([
  "BORRADOR",
  "PENDIENTE_APROBACION",
  "PROGRAMADA",
  "ACTIVA",
  "PAUSADA",
  "AGOTADA",
  "CERRADA",
  "EN_SORTEO",
  "GANADOR_PUBLICADO",
  "FINALIZADA",
  "CANCELADA",
]);

export const raffleCreateSchema = z.object({
  title: z.string().trim().min(2, "El título es obligatorio").max(200),
  description: z.string().trim().min(2, "La descripción es obligatoria").max(5000),
  prize: z.string().trim().min(2, "El premio es obligatorio").max(500),
  imageUrl: z.string().trim().url("La imagen debe ser una URL válida").max(1000).optional(),
  countryId: z.string().trim().min(1, "El país es obligatorio"),
  ticketPrice: z.number().int("El precio debe ser entero").positive("El precio debe ser mayor que 0"),
  totalTickets: z.number().int("El total de boletos debe ser entero").positive().max(100000),
  drawAt: z.coerce.date(),
  rules: z.string().trim().max(10000).optional(),
  licenseNumber: z.string().trim().max(100).nullable().optional(),
  minTicketsToDraw: z.number().int().positive().optional(),
  maxTicketsPerPurchase: z.number().int().positive().optional(),
  maxTicketsPerCustomer: z.number().int().positive().optional(),
});

export const rafflePatchSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().min(2).max(5000).optional(),
  prize: z.string().trim().min(2).max(500).optional(),
  imageUrl: z.string().trim().url("La imagen debe ser una URL válida").max(1000).nullable().optional(),
  ticketPrice: z.number().int().positive().optional(),
  totalTickets: z.number().int().positive().max(100000).optional(),
  drawAt: z.coerce.date().optional(),
  rules: z.string().trim().max(10000).optional(),
  licenseNumber: z.string().trim().max(100).nullable().optional(),
  minTicketsToDraw: z.number().int().positive().nullable().optional(),
  maxTicketsPerPurchase: z.number().int().positive().nullable().optional(),
  maxTicketsPerCustomer: z.number().int().positive().nullable().optional(),
  // Motivo obligatorio para cambiar la fecha de sorteo (plan §2.7) y
  // recomendado para cualquier cambio sensible (§2.20).
  reason: z.string().trim().max(2000).optional(),
  // Doble aprobación (§2.20): id de un SEGUNDO administrador (SUPERADMIN,
  // distinto del actor) que aprueba un cambio sensible con ventas hechas.
  approvedById: z.string().trim().min(1).nullable().optional(),
});

export const raffleTransitionSchema = z.object({
  to: raffleStatusEnum,
  reason: z.string().trim().max(2000).optional(),
});

// ---------------------------------------------------------------- S3: países (plan §2.9)
// Los 16 campos del flujo "Agregar país": nombre; bandera y código ISO;
// moneda local y código ISO de moneda; símbolo y formato monetario;
// idiomas disponibles y predeterminado; zona horaria; formato de fecha y
// hora; métodos de pago disponibles; pasarelas/proveedores asignados;
// comisiones de procesamiento; límites de transacción; reglas de
// participación; países permitidos/restringidos; configuración legal y
// términos; estado de activación; configuración de notificaciones; reglas
// de reembolsos y contracargos. (Las comisiones y límites viven en
// CountryPaymentConfig, por método/proveedor.)
const ianaTimezone = z
  .string()
  .trim()
  .min(1, "La zona horaria es obligatoria")
  .refine(
    (tz) => {
      try {
        Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Zona horaria IANA inválida" },
  );

const countryPaymentMethodSchema = z.object({
  providerCode: z.string().trim().min(1),
  methodCode: z.enum(["MANUAL_TRANSFER", "PAYPAL", "AZUL_CARD", "CARDNET_CARD"]),
  priority: z.number().int().min(1).default(1),
  feeFixed: z.number().int().min(0).default(0),
  feePercentBps: z.number().int().min(0).max(10000).default(0),
  limits: z.unknown().optional(),
  enabled: z.boolean().default(false),
});

export const countryCreateSchema = z.object({
  code: z.string().trim().length(2, "El código ISO debe tener 2 letras").toUpperCase(),
  name: z.string().trim().min(2, "El nombre es obligatorio").max(120),
  flag: z.string().trim().max(100).optional(),
  currencyCode: z.string().trim().length(3, "El código de moneda ISO debe tener 3 letras").toUpperCase(),
  currencySymbol: z.string().trim().min(1, "El símbolo de moneda es obligatorio").max(10),
  currencyFormat: z.string().trim().max(50).optional(),
  defaultLanguage: z.string().trim().min(2).max(5).default("es"),
  availableLanguages: z.array(z.string().trim().min(2).max(5)).min(1).default(["es"]),
  timezone: ianaTimezone,
  dateFormat: z.string().trim().max(20).default("DD/MM/YYYY"),
  timeFormat: z.string().trim().max(20).optional(),
  allowedCountries: z.array(z.string().trim().length(2).toUpperCase()).optional(),
  blockedCountries: z.array(z.string().trim().length(2).toUpperCase()).optional(),
  legalConfig: z.unknown().optional(),
  notificationConfig: z.unknown().optional(),
  refundRules: z.unknown().optional(),
  classification: z.enum(["A", "B", "C"]).default("C"),
  // El estado de activación NUNCA es ACTIVO en la creación: activar exige
  // el gate de POST /api/admin/countries/[id]/activate (P18).
  status: z.enum(["BORRADOR", "CONFIGURACION", "REVISION"]).default("BORRADOR"),
  legalVerified: z.boolean().default(false),
  providerVerified: z.boolean().default(false),
  paymentMethods: z.array(countryPaymentMethodSchema).optional(),
});

// PATCH de país: los mismos campos, todos opcionales. ACTIVO no se admite
// aquí (usar el endpoint de activación con gate); el schema lo excluye.
export const countryPatchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  flag: z.string().trim().max(100).nullable().optional(),
  currencyCode: z.string().trim().length(3).toUpperCase().optional(),
  currencySymbol: z.string().trim().min(1).max(10).optional(),
  currencyFormat: z.string().trim().max(50).nullable().optional(),
  defaultLanguage: z.string().trim().min(2).max(5).optional(),
  availableLanguages: z.array(z.string().trim().min(2).max(5)).min(1).optional(),
  timezone: ianaTimezone.optional(),
  dateFormat: z.string().trim().max(20).optional(),
  timeFormat: z.string().trim().max(20).nullable().optional(),
  allowedCountries: z.array(z.string().trim().length(2).toUpperCase()).nullable().optional(),
  blockedCountries: z.array(z.string().trim().length(2).toUpperCase()).nullable().optional(),
  legalConfig: z.unknown().optional(),
  notificationConfig: z.unknown().optional(),
  refundRules: z.unknown().optional(),
  classification: z.enum(["A", "B", "C"]).optional(),
  status: z.enum(["BORRADOR", "CONFIGURACION", "REVISION"]).optional(),
  legalVerified: z.boolean().optional(),
  providerVerified: z.boolean().optional(),
  paymentMethods: z.array(countryPaymentMethodSchema).optional(),
  reason: z.string().trim().max(2000).optional(),
});

/** Lee el JSON del body y lo valida con el schema. 400 si no es válido. */
export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw badRequest("Cuerpo JSON inválido");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw badRequest(first ? first.message : "Datos inválidos");
  }
  return parsed.data;
}
