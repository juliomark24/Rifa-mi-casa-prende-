"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "./clientApi";
import { statusLabel } from "./format";
import { RAFFLE_NEXT_STATES } from "./types";
import type { RaffleStatus } from "./types";

/**
 * Acciones de admin (contrato v2.2). Todas confirman antes de actuar y
 * muestran el error {error} de la API. No existe DELETE de rifa en el
 * contrato: cancelar una rifa es una transición (CANCELADA), que activa
 * el flujo de reembolsos (plan §2.7).
 */

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, url: string, method: string, body?: unknown, confirmMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(key);
    setError(null);
    try {
      const res = await clientApi(url, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, run };
}

const btnDanger = "rounded-md bg-rose-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50";
const btnOk = "rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50";
const btnGhost = "rounded-md border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-50";
const btnWarn = "rounded-md bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-50";

/** Transición de estado de rifa (máquina de 11 estados). */
export function RaffleTransition({ id, status }: { id: string; status: RaffleStatus }) {
  const { busy, error, run } = useAction();
  const next = RAFFLE_NEXT_STATES[status] ?? [];
  const [to, setTo] = useState<RaffleStatus | "">(next[0] ?? "");
  if (next.length === 0) return <span className="text-xs text-stone-400">Sin transiciones</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <select value={to} onChange={(e) => setTo(e.target.value as RaffleStatus)} className="rounded-md border border-stone-300 px-2 py-1.5 text-xs" aria-label="Nuevo estado">
        {next.map((s) => (
          <option key={s} value={s}>
            {statusLabel(s)}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy !== null || !to}
        onClick={() =>
          run(
            id,
            `/api/admin/raffles/${id}/transition`,
            "POST",
            { to },
            to === "CANCELADA"
              ? "¿Cancelar esta rifa? Se activa el flujo de reembolsos de las órdenes pagadas."
              : `¿Cambiar el estado de la rifa a "${statusLabel(to as string)}"?`
          )
        }
        className={btnGhost}
      >
        {busy === id ? "…" : "Aplicar"}
      </button>
      {error && <span className="w-full text-xs text-rose-700">{error}</span>}
    </span>
  );
}

/** Órdenes: confirmar transferencia, cancelar o reembolsar. */
export function OrderActions({ id, status }: { id: string; status: string }) {
  const { busy, error, run } = useAction();
  return (
    <span className="flex flex-wrap gap-2">
      {status === "PENDIENTE" && (
        <>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run(`${id}-c`, `/api/admin/orders/${id}/confirm`, "POST", undefined, "¿Confirmar que la transferencia fue recibida? La orden pasará a CONFIRMADA y se generarán las comisiones.")}
            className={btnOk}
          >
            {busy === `${id}-c` ? "Confirmando…" : "Confirmar pago"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run(`${id}-x`, `/api/admin/orders/${id}/cancel`, "POST", undefined, "¿Cancelar esta orden? Los boletos volverán a estar disponibles.")}
            className={btnDanger}
          >
            {busy === `${id}-x` ? "Cancelando…" : "Cancelar"}
          </button>
        </>
      )}
      {status === "CONFIRMADO" && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => run(`${id}-r`, `/api/admin/orders/${id}/refund`, "POST", undefined, "¿Reembolsar esta orden? Se ajustará la comisión del afiliado si la hubo.")}
          className={btnWarn}
        >
          {busy === `${id}-r` ? "…" : "Reembolsar"}
        </button>
      )}
      {status !== "PENDIENTE" && status !== "CONFIRMADO" && <span className="text-xs text-stone-400">—</span>}
      {error && <span className="w-full text-xs text-rose-700">{error}</span>}
    </span>
  );
}

/** Boletos: bloquear / desbloquear / anular (con motivo obligatorio). */
export function TicketBlockActions({ id, status }: { id: string; status: string }) {
  const { busy, error, run } = useAction();
  if (status === "ANULADO") return <span className="text-xs text-stone-400">Anulado</span>;

  function annul() {
    const reason = window.prompt("Motivo de la anulación (obligatorio, queda en el historial):");
    if (!reason || !reason.trim()) return;
    void run(
      `${id}-a`,
      `/api/admin/tickets/${id}/annul`,
      "POST",
      { reason: reason.trim() },
      status === "VENDIDO"
        ? "Este boleto está pagado: la anulación dispara el flujo de reembolso. ¿Continuar?"
        : "¿Anular este boleto?"
    );
  }

  return (
    <span className="flex flex-wrap gap-2">
      {status === "RESERVADO" || status === "DISPONIBLE" ? (
        <button type="button" disabled={busy !== null} onClick={() => run(id, `/api/admin/tickets/${id}/block`, "POST")} className={btnDanger}>
          {busy === id ? "…" : "Bloquear"}
        </button>
      ) : null}
      <button type="button" disabled={busy !== null} onClick={annul} className={btnWarn}>
        {busy === `${id}-a` ? "…" : "Anular"}
      </button>
      {error && <span className="w-full text-xs text-rose-700">{error}</span>}
    </span>
  );
}

/** Boletos bloqueados: desbloquear (se muestra solo cuando aplica). */
export function TicketUnblockButton({ id }: { id: string }) {
  const { busy, error, run } = useAction();
  return (
    <span>
      <button type="button" disabled={busy !== null} onClick={() => run(id, `/api/admin/tickets/${id}/unblock`, "POST")} className={btnOk}>
        {busy === id ? "…" : "Desbloquear"}
      </button>
      {error && <span className="ml-2 text-xs text-rose-700">{error}</span>}
    </span>
  );
}

export function WithdrawalActions({ id }: { id: string }) {
  const { busy, error, run } = useAction();
  return (
    <span className="flex flex-wrap gap-2">
      <button type="button" disabled={busy !== null} onClick={() => run(`${id}-p`, `/api/admin/withdrawals/${id}/pay`, "POST", undefined, "¿Marcar este retiro como PAGADO?")} className={btnOk}>
        {busy === `${id}-p` ? "…" : "Marcar pagado"}
      </button>
      <button type="button" disabled={busy !== null} onClick={() => run(`${id}-r`, `/api/admin/withdrawals/${id}/reject`, "POST", undefined, "¿Rechazar este retiro?")} className={btnDanger}>
        {busy === `${id}-r` ? "…" : "Rechazar"}
      </button>
      {error && <span className="w-full text-xs text-rose-700">{error}</span>}
    </span>
  );
}

/**
 * Sorteo en dos pasos (commit-reveal, contrato v2.2):
 *  1. commit: congela elegibles + publica el commitment.
 *  2. execute: revela la semilla + ganador (bloqueado si hay pagos o
 *     reservas sin resolver, o si ya se sorteó).
 */
export function DrawActions({ raffleId, committed }: { raffleId: string; committed?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function call(step: "commit" | "execute") {
    const confirmMsg =
      step === "commit"
        ? "¿Publicar el compromiso del sorteo? Se congelan los boletos elegibles y ya no se podrá vender ni anular nada de esta rifa."
        : "¿Ejecutar el sorteo? Revela la semilla y elige al ganador. Solo se puede sortear una vez.";
    if (!window.confirm(confirmMsg)) return;
    setBusy(step);
    setError(null);
    setDone(null);
    try {
      const res = await clientApi<{ draw?: { winnerTicketNumber?: number; winnerTicketCode?: string }; commitment?: string }>(
        `/api/admin/raffles/${raffleId}/draw/${step}`,
        { method: "POST" }
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (step === "commit") setDone(`Compromiso publicado${res.data?.commitment ? `: ${String(res.data.commitment).slice(0, 20)}…` : "."}`);
      else {
        const w = res.data?.draw;
        setDone(w?.winnerTicketNumber !== undefined ? `Ganador: boleto #${w.winnerTicketNumber} (${w.winnerTicketCode ?? ""})` : "Sorteo ejecutado.");
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <span className="flex flex-wrap gap-2">
        <button type="button" disabled={busy !== null} onClick={() => call("commit")} className={btnWarn}>
          {busy === "commit" ? "Publicando…" : committed ? "Compromiso publicado ✓" : "1. Publicar compromiso"}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => call("execute")} className={btnOk}>
          {busy === "execute" ? "Sorteando…" : "2. Ejecutar sorteo"}
        </button>
      </span>
      {done && <span className="text-xs font-medium text-emerald-700">{done}</span>}
      {error && <span className="text-xs text-rose-700">{error}</span>}
    </span>
  );
}

export function DeletePaymentMethodButton({ id, label }: { id: string; label: string }) {
  const { busy, error, run } = useAction();
  return (
    <span>
      <button type="button" disabled={busy !== null} onClick={() => run(id, `/api/admin/payment-methods/${id}`, "DELETE", undefined, `¿Eliminar el método "${label}"?`)} className={btnDanger}>
        {busy === id ? "…" : "Eliminar"}
      </button>
      {error && <span className="ml-2 text-xs text-rose-700">{error}</span>}
    </span>
  );
}

export function TogglePaymentMethodButton({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await clientApi(`/api/admin/payment-methods/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !enabled }),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span>
      <button type="button" disabled={busy} onClick={toggle} className={btnGhost}>
        {busy ? "…" : enabled ? "Desactivar" : "Activar"}
      </button>
      {error && <span className="ml-2 text-xs text-rose-700">{error}</span>}
    </span>
  );
}
