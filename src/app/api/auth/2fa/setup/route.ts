// POST /api/auth/2fa/setup — ADMIN*. Inicia 2FA TOTP.
// Devuelve otpauthUrl + backupCodes (mostrar UNA sola vez).
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, logAudit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { conflict, errorResponse, forbidden } from "@/lib/errors";
import { isAdminRole } from "@/lib/permissions";
import { encryptSecret, generateBackupCodes, generateTotpSecret, totpAuthUrl } from "@/lib/totp";

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireAuth(req);
    if (!isAdminRole(user.role)) {
      throw forbidden("2FA solo aplica a roles administrativos");
    }
    const existing = await db.twoFactor.findUnique({ where: { userId: user.id } });
    if (existing?.enabled) throw conflict("2FA ya está activo para esta cuenta");

    const secret = generateTotpSecret();
    const { codes, hashes } = generateBackupCodes(8);
    await db.twoFactor.upsert({
      where: { userId: user.id },
      update: { secretEncrypted: encryptSecret(secret), enabled: false, backupCodesHash: hashes },
      create: {
        userId: user.id,
        secretEncrypted: encryptSecret(secret),
        enabled: false,
        backupCodesHash: hashes,
      },
    });
    await logAudit({
      actorId: user.id,
      action: "auth.2fa.setup",
      entity: "TwoFactor",
      entityId: user.id,
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({
      otpauthUrl: totpAuthUrl(secret, user.email),
      backupCodes: codes,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
