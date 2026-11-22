// Seed de desarrollo (S1). Idempotente (upserts).
// Crea: superadmin, país DO (ACTIVO, clase A), 4 proveedores preintegrados
// (solo transferencia manual OPERATIVA — regla 6), métodos y configuración
// por país, rifa demo (BORRADOR) con bases v1 y afiliado demo.
// NUNCA se ejecuta en producción con estos valores.
import "dotenv/config";
import { hashPassword } from "../src/lib/auth";
import { db } from "../src/lib/db";

async function main() {
  // --- Ajustes (COMMISSION_RATE en POR CIENTO: "10" = 10%, ver money.ts) ---
  await db.setting.upsert({
    where: { key: "COMMISSION_RATE" },
    update: { value: "10" },
    create: { key: "COMMISSION_RATE", value: "10" },
  });
  await db.setting.upsert({
    where: { key: "RESERVATION_MINUTES" },
    update: { value: "10" },
    create: { key: "RESERVATION_MINUTES", value: "10" },
  });
  await db.setting.upsert({
    where: { key: "MIN_WITHDRAWAL" },
    update: { value: "500" },
    create: { key: "MIN_WITHDRAWAL", value: "500" },
  });
  await db.setting.upsert({
    where: { key: "RETENTION_DAYS" },
    update: { value: "7" },
    create: { key: "RETENTION_DAYS", value: "7" },
  });

  // --- Superadmin ---
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@prenderifas.do";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword) {
    console.warn("SEED_ADMIN_PASSWORD no definida: se omite el superadmin.");
  } else {
    await db.user.upsert({
      where: { email: adminEmail },
      update: { role: "SUPERADMIN" },
      create: {
        name: "Admin Prende Rifas",
        email: adminEmail,
        passwordHash: await hashPassword(adminPassword),
        role: "SUPERADMIN",
      },
    });
    console.log(`Superadmin: ${adminEmail}`);
  }

  // --- País DO (ACTIVO, clase A) ---
  const country = await db.country.upsert({
    where: { code: "DO" },
    update: { status: "ACTIVO", classification: "A" },
    create: {
      code: "DO",
      name: "República Dominicana",
      flag: "🇩🇴",
      currencyCode: "DOP",
      currencySymbol: "RD$",
      currencyFormat: "RD$ #,##0",
      defaultLanguage: "es",
      availableLanguages: ["es"],
      timezone: "America/Santo_Domingo",
      dateFormat: "DD/MM/YYYY",
      timeFormat: "HH:mm",
      allowedCountries: ["DO"],
      blockedCountries: [],
      legalConfig: { licenseRequired: true, authority: "Ministerio de Hacienda / Pro Consumidor" },
      notificationConfig: { channels: ["EMAIL", "WHATSAPP"] },
      refundRules: { refundWindowDays: 7 },
      classification: "A",
      status: "ACTIVO",
      legalVerified: false,
      providerVerified: false,
    },
  });

  // --- Proveedores preintegrados (regla 6: solo manual operativo) ---
  const manual = await db.paymentProvider.upsert({
    where: { code: "MANUAL_TRANSFER" },
    update: { status: "OPERATIVO", authorizedForRaffles: true },
    create: {
      code: "MANUAL_TRANSFER",
      name: "Transferencia manual",
      type: "MANUAL",
      status: "OPERATIVO",
      sandboxMode: false,
      authorizedForRaffles: true,
      verifiedAt: new Date(),
      notes: "Método de respaldo desde el día uno: un admin verifica el comprobante.",
    },
  });
  const paypal = await db.paymentProvider.upsert({
    where: { code: "PAYPAL" },
    update: { status: "NO_OPERATIVO" },
    create: {
      code: "PAYPAL",
      name: "PayPal",
      type: "GATEWAY",
      status: "NO_OPERATIVO",
      sandboxMode: true,
      authorizedForRaffles: false,
      notes: "Puente rápido. Skeleton NO operativo hasta verificación real (regla 6).",
    },
  });
  const azul = await db.paymentProvider.upsert({
    where: { code: "AZUL" },
    update: { status: "NO_OPERATIVO" },
    create: {
      code: "AZUL",
      name: "Azul (Banco Popular)",
      type: "GATEWAY",
      status: "NO_OPERATIVO",
      sandboxMode: true,
      authorizedForRaffles: false,
      notes: "Requiere afiliación (RNC + cuenta comercial + homologación). Skeleton NO operativo.",
    },
  });
  const cardnet = await db.paymentProvider.upsert({
    where: { code: "CARDNET" },
    update: { status: "NO_OPERATIVO" },
    create: {
      code: "CARDNET",
      name: "CardNet (Banreservas)",
      type: "GATEWAY",
      status: "NO_OPERATIVO",
      sandboxMode: true,
      authorizedForRaffles: false,
      notes: "Requiere afiliación (RNC + cuenta comercial + homologación). Skeleton NO operativo.",
    },
  });

  // --- Métodos de pago ---
  const methodManual = await db.paymentMethod.upsert({
    where: { code: "MANUAL_TRANSFER" },
    update: { enabled: true },
    create: {
      code: "MANUAL_TRANSFER",
      providerId: manual.id,
      label: "Transferencia bancaria",
      details: "Transfiere con el código de tu pedido como referencia.",
      enabled: true,
    },
  });
  const methodPaypal = await db.paymentMethod.upsert({
    where: { code: "PAYPAL" },
    update: { enabled: false },
    create: { code: "PAYPAL", providerId: paypal.id, label: "PayPal", enabled: false },
  });
  const methodAzul = await db.paymentMethod.upsert({
    where: { code: "AZUL_CARD" },
    update: { enabled: false },
    create: { code: "AZUL_CARD", providerId: azul.id, label: "Tarjeta (Azul)", enabled: false },
  });
  const methodCardnet = await db.paymentMethod.upsert({
    where: { code: "CARDNET_CARD" },
    update: { enabled: false },
    create: { code: "CARDNET_CARD", providerId: cardnet.id, label: "Tarjeta (CardNet)", enabled: false },
  });

  // --- Configuración por país (DO) ---
  const configs: Array<{ providerId: string; methodId: string; priority: number; enabled: boolean }> = [
    { providerId: manual.id, methodId: methodManual.id, priority: 1, enabled: true },
    { providerId: paypal.id, methodId: methodPaypal.id, priority: 2, enabled: false },
    { providerId: azul.id, methodId: methodAzul.id, priority: 3, enabled: false },
    { providerId: cardnet.id, methodId: methodCardnet.id, priority: 4, enabled: false },
  ];
  for (const c of configs) {
    await db.countryPaymentConfig.upsert({
      where: {
        countryId_providerId_methodId: { countryId: country.id, providerId: c.providerId, methodId: c.methodId },
      },
      update: { priority: c.priority, enabled: c.enabled },
      create: { countryId: country.id, providerId: c.providerId, methodId: c.methodId, priority: c.priority, enabled: c.enabled },
    });
  }

  // --- Afiliado demo ---
  await db.user.upsert({
    where: { email: "afiliado@demo.prenderifas.do" },
    update: {},
    create: {
      name: "Afiliado Demo",
      email: "afiliado@demo.prenderifas.do",
      passwordHash: await hashPassword(process.env.SEED_DEMO_PASSWORD ?? "Demo1234!"),
      role: "AFILIADO",
      referralCode: "PRENDEDEMO",
    },
  });

  // --- Rifa demo (BORRADOR, sin licencia: no publicable) ---
  const drawAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const raffle = await db.raffle.upsert({
    where: { id: "demo-raffle-001" },
    update: {},
    create: {
      id: "demo-raffle-001",
      title: "Rifa Demo — Prende Rifas",
      description: "Rifa de demostración para pruebas. No es una rifa real.",
      prize: "Premio demo (sin valor comercial)",
      countryId: country.id,
      currency: "DOP",
      ticketPrice: 100,
      totalTickets: 100,
      drawAt,
      status: "BORRADOR",
      rules: "Bases de demostración.",
      licenseNumber: null,
    },
  });
  await db.raffleTerms.upsert({
    where: { raffleId_version: { raffleId: raffle.id, version: 1 } },
    update: {},
    create: {
      raffleId: raffle.id,
      version: 1,
      content: "Bases v1 de la rifa demo: participación solo con fines de prueba.",
    },
  });
  await db.raffle.update({
    where: { id: raffle.id },
    data: { termsVersionId: (await db.raffleTerms.findFirst({ where: { raffleId: raffle.id, version: 1 } }))?.id },
  });

  console.log("Seed completado: DO ACTIVO, 4 proveedores (solo manual operativo), rifa demo, afiliado demo.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
