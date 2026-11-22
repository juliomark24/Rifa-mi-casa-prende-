// Matriz RBAC — 7 roles (plan §2.8). Cada endpoint verifica el PERMISO,
// no solo el rol. P11 (parcial, S2): cliente no entra al admin, afiliado
// no ve finanzas, auditor no modifica nada, admin de rifas no aprueba retiros.
import { forbidden } from "./errors";
import type { Role } from "../generated/prisma/client";

export const ADMIN_ROLES: Role[] = ["SUPERADMIN", "ADMIN_RIFAS", "FINANZAS", "AUDITOR", "MARKETING"];

export function isAdminRole(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}

export type Permission =
  | "raffles.view"
  | "raffles.create"
  | "raffles.edit"
  | "raffles.transition"
  | "raffles.draw"
  | "orders.view"
  | "orders.confirm"
  | "orders.cancel"
  | "orders.refund"
  | "tickets.view"
  | "tickets.manage"
  | "payments.view"
  | "payments.verify"
  | "withdrawals.view"
  | "withdrawals.approve"
  | "withdrawals.pay"
  | "affiliates.view"
  | "affiliates.manage"
  | "countries.view"
  | "countries.manage"
  | "countries.activate"
  | "paymentProviders.view"
  | "paymentProviders.manage"
  | "settings.view"
  | "settings.edit"
  | "reports.view"
  | "audit.view"
  | "support.view"
  | "support.manage"
  | "fraud.view"
  | "fraud.review"
  | "notifications.view"
  | "winners.view"
  | "winners.manage"
  | "monitoring.view"
  | "recovery.approve"
  | "users.manage";

const ALL_READ: Permission[] = [
  "raffles.view",
  "orders.view",
  "tickets.view",
  "payments.view",
  "withdrawals.view",
  "affiliates.view",
  "countries.view",
  "paymentProviders.view",
  "settings.view",
  "reports.view",
  "audit.view",
  "support.view",
  "fraud.view",
  "notifications.view",
  "winners.view",
  "monitoring.view",
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPERADMIN: [
    ...ALL_READ,
    "raffles.create",
    "raffles.edit",
    "raffles.transition",
    "raffles.draw",
    "orders.confirm",
    "orders.cancel",
    "orders.refund",
    "tickets.manage",
    "payments.verify",
    "withdrawals.approve",
    "withdrawals.pay",
    "affiliates.manage",
    "countries.manage",
    "countries.activate",
    "paymentProviders.manage",
    "settings.edit",
    "support.manage",
    "fraud.review",
    "winners.manage",
    "recovery.approve",
    "users.manage",
  ],
  ADMIN_RIFAS: [
    "raffles.view",
    "raffles.create",
    "raffles.edit",
    "raffles.transition",
    "raffles.draw",
    "orders.view",
    "tickets.view",
    "tickets.manage",
    "affiliates.view",
    "countries.view",
    "paymentProviders.view",
    "reports.view",
    "support.view",
    "winners.view",
    "winners.manage",
    "notifications.view",
  ],
  FINANZAS: [
    "orders.view",
    "orders.confirm",
    "orders.cancel",
    "orders.refund",
    "tickets.view",
    "payments.view",
    "payments.verify",
    "withdrawals.view",
    "withdrawals.approve",
    "withdrawals.pay",
    "affiliates.view",
    "paymentProviders.view",
    "paymentProviders.manage",
    "countries.view",
    "reports.view",
    "audit.view",
    "fraud.view",
    "notifications.view",
    "winners.view",
    "raffles.view",
  ],
  // Auditor: solo lectura de todo, sin modificar (P11).
  AUDITOR: [...ALL_READ],
  MARKETING: [
    "raffles.view",
    "affiliates.view",
    "affiliates.manage",
    "countries.view",
    "paymentProviders.view",
    "reports.view",
    "notifications.view",
    "support.view",
    "winners.view",
    "orders.view",
    "tickets.view",
  ],
  // Afiliado y cliente: solo sus propios datos (los endpoints "me" no usan
  // esta matriz; verifican ownership). Sin permisos de admin.
  AFILIADO: [],
  CLIENTE: [],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function requirePermissionOrThrow(role: Role, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw forbidden(`El rol ${role} no tiene el permiso ${permission}`);
  }
}
