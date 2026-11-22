-- AlterTable
ALTER TABLE "PaymentProvider" ADD COLUMN "credentialsEncrypted" TEXT;

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN "buyerEmail" TEXT;
