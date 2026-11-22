// Presentación de métodos de pago para el panel (S9-int).
// El código de método es ÚNICO en el schema: un método es global y su
// habilitación por país vive en CountryPaymentConfig; la forma del panel
// deriva país/moneda/entorno de la primera configuración y del modo del
// proveedor (no existen como columnas del método).
export const METHOD_PROVIDER: Record<string, string> = {
  MANUAL_TRANSFER: "MANUAL_TRANSFER",
  PAYPAL: "PAYPAL",
  AZUL_CARD: "AZUL",
  CARDNET_CARD: "CARDNET",
};

export type PaymentMethodRow = {
  id: string;
  code: string;
  label: string;
  details: string;
  enabled: boolean;
  createdAt: Date;
  provider: { code: string; name: string; status: string; sandboxMode: boolean };
  configs: Array<{
    country: { code: string; currencyCode: string };
    enabled: boolean;
    priority: number;
  }>;
};

/** Forma que consume el panel: país/moneda/entorno derivados de la config. */
export function presentPaymentMethod(method: PaymentMethodRow) {
  const first = method.configs[0];
  return {
    id: method.id,
    code: method.code,
    label: method.label,
    details: method.details,
    enabled: method.enabled,
    provider: method.provider.code,
    providerName: method.provider.name,
    providerStatus: method.provider.status,
    // El frontend histórico esperaba país/moneda/entorno por fila: se
    // derivan de la primera configuración y del modo del proveedor.
    country: first?.country.code ?? "",
    currency: first?.country.currencyCode ?? "",
    environment: method.provider.sandboxMode ? "sandbox" : "production",
    configs: method.configs.map((c) => ({
      country: c.country.code,
      currency: c.country.currencyCode,
      enabled: c.enabled,
      priority: c.priority,
    })),
    createdAt: method.createdAt,
  };
}
