"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "./clientApi";
import { statusLabel } from "./format";
import { WINNER_NEXT } from "./types";
import type { RiskStatus, SupportTicketStatus, WinnerCaseStatus, WinnerOutcome } from "./types";

/**
 * Acciones de casos admin (contrato v2.2).
 *
 * TODO (hueco del contrato): el contrato define las rutas PATCH pero no la
 * forma del cuerpo. Se envían los campos con los nombres del plan
 * ({status, evidence?, note?} / {status, assignee?} / {riskStatus,
 * decision?}); si el backend espera otros nombres, la API responde el
 * error y se ajusta aquí.
 */

function usePatch() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function patch(url: string, body: unknown, okMsg: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await clientApi(url, { method: "PATCH", body: JSON.stringify(body) });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone(okMsg);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, done, patch };
}

/** Avance del caso del ganador (7 estados, plan §2.15) + evidencia.
 * S9-int: el backend es estricto (un paso a la vez, 409 ante saltos o
 * retrocesos), así que el formulario solo ofrece el SIGUIENTE estado
 * válido desde el actual — nunca la lista completa. El mismo estado
 * permite añadir evidencia/nota sin avanzar. Cerrar (CASO_CERRADO)
 * exige evidencia de entrega (fotos o acta + fecha + responsable); sin
 * ella la API responde 409. El procedimiento de las bases (no elegible,
 * renuncia, sin respuesta, entrega imposible) se registra con nota y NO
 * avanza el caso. */
export function WinnerCaseActions({ id, status }: { id: string; status: WinnerCaseStatus }) {
  const { busy, error, done, patch } = usePatch();
  const next = WINNER_NEXT[status];
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  const [contactChannel, setContactChannel] = useState("");
  const [outcome, setOutcome] = useState<WinnerOutcome | "">("");
  const [deadlineDays, setDeadlineDays] = useState("");
  const isClosed = status === "CASO_CERRADO";
  return (
    <span className="flex flex-wrap items-center gap-2">
      {isClosed ? (
        <span className="text-xs font-bold text-emerald-700">Caso cerrado (entrega registrada).</span>
      ) : (
        <>
          <span className="text-xs text-stone-600">
            Siguiente paso: <strong>{next ? statusLabel(next) : "—"}</strong>
          </span>
          <button
            type="button"
            disabled={busy || !next}
            onClick={() =>
              patch(
                `/api/admin/winners/${id}`,
                {
                  status: next,
                  evidence: evidence.trim() || undefined,
                  note: note.trim() || undefined,
                  contactChannel: contactChannel.trim() || undefined,
                },
                `Caso avanzado a ${next ? statusLabel(next) : ""}.`,
              )
            }
            className="rounded-md bg-orange-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-orange-700 disabled:opacity-50"
          >
            {busy ? "…" : `Avanzar a ${next ? statusLabel(next) : "—"}`}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              patch(
                `/api/admin/winners/${id}`,
                {
                  status,
                  evidence: evidence.trim() || undefined,
                  note: note.trim() || undefined,
                  contactChannel: contactChannel.trim() || undefined,
                },
                "Evidencia/nota guardada sin avanzar el caso.",
              )
            }
            className="rounded-md border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          >
            {busy ? "…" : "Guardar evidencia/nota"}
          </button>
        </>
      )}
      <input
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
        placeholder="Evidencia (fotos/acta, fecha y responsable para cerrar)"
        className="w-64 rounded-md border border-stone-300 px-2 py-1.5 text-xs"
      />
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Nota del paso"
        className="w-40 rounded-md border border-stone-300 px-2 py-1.5 text-xs"
      />
      <input
        value={contactChannel}
        onChange={(e) => setContactChannel(e.target.value)}
        placeholder="Canal de contacto (ej. WhatsApp)"
        className="w-40 rounded-md border border-stone-300 px-2 py-1.5 text-xs"
      />
      {!isClosed && (
        <span className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5">
          <label className="text-xs text-stone-600">
            Procedimiento de las bases:
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as WinnerOutcome | "")}
              className="ml-1 rounded-md border border-stone-300 px-2 py-1 text-xs"
            >
              <option value="">— ninguno —</option>
              <option value="NO_ELEGIBLE">Ganador no elegible</option>
              <option value="RENUNCIA">Ganador renuncia al premio</option>
              <option value="SIN_RESPUESTA">Ganador no responde</option>
              <option value="ENTREGA_IMPOSIBLE">Imposibilidad de entrega</option>
            </select>
          </label>
          {outcome === "SIN_RESPUESTA" && (
            <label className="text-xs text-stone-600">
              Plazo (días):
              <input
                type="number"
                min={1}
                max={365}
                value={deadlineDays}
                onChange={(e) => setDeadlineDays(e.target.value)}
                className="ml-1 w-16 rounded-md border border-stone-300 px-2 py-1 text-xs"
              />
            </label>
          )}
          <button
            type="button"
            disabled={busy || !outcome || !note.trim()}
            title={!note.trim() ? "El procedimiento exige una nota que describa lo ocurrido" : undefined}
            onClick={() =>
              patch(
                `/api/admin/winners/${id}`,
                {
                  outcome,
                  note: note.trim(),
                  evidence: evidence.trim() || undefined,
                  contactChannel: contactChannel.trim() || undefined,
                  deadlineDays: deadlineDays ? Number(deadlineDays) : undefined,
                },
                "Procedimiento registrado (el caso sigue abierto).",
              )
            }
            className="rounded-md bg-amber-600 px-3 py-1 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {busy ? "…" : "Registrar procedimiento"}
          </button>
        </span>
      )}
      {done && <span className="text-xs font-medium text-emerald-700">{done}</span>}
      {error && <span className="w-full text-xs text-rose-700">{error}</span>}
    </span>
  );
}

const SUPPORT_FLOW: SupportTicketStatus[] = ["ABIERTO", "EN_REVISION", "ESPERANDO_CLIENTE", "RESUELTO", "CERRADO"];

/** Tickets de soporte: cambio de estado + responsable.
 * S9-int: la API espera `assignee` como ID de un usuario admin (o null
 * para desasignar); el formulario anterior lo trataba como texto libre
 * y la API respondía 400 ("el responsable no existe"). Ahora el campo
 * se etiqueta como ID y hay botón para quitar el responsable. */
export function SupportTicketActions({
  id,
  status,
  currentAssignee,
}: {
  id: string;
  status: SupportTicketStatus;
  currentAssignee?: string | null;
}) {
  const { busy, error, done, patch } = usePatch();
  const [to, setTo] = useState<SupportTicketStatus>(status);
  const [assignee, setAssignee] = useState("");
  return (
    <span className="flex flex-wrap items-center gap-2">
      <select value={to} onChange={(e) => setTo(e.target.value as SupportTicketStatus)} className="rounded-md border border-stone-300 px-2 py-1.5 text-xs" aria-label="Nuevo estado del ticket">
        {SUPPORT_FLOW.map((s) => (
          <option key={s} value={s}>
            {statusLabel(s)}
          </option>
        ))}
      </select>
      <input
        value={assignee}
        onChange={(e) => setAssignee(e.target.value)}
        placeholder="ID del admin responsable (opcional)"
        title="Debe ser el ID de un usuario administrador; un nombre o un correo no sirve"
        className="w-52 rounded-md border border-stone-300 px-2 py-1.5 text-xs"
      />
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          patch(`/api/admin/support-tickets/${id}`, { status: to, assignee: assignee.trim() || undefined }, "Ticket actualizado.")
        }
        className="rounded-md bg-orange-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-orange-700 disabled:opacity-50"
      >
        {busy ? "…" : "Actualizar"}
      </button>
      {currentAssignee && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            patch(`/api/admin/support-tickets/${id}`, { status: to, assignee: null }, "Responsable quitado.")
          }
          className="rounded-md border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-50"
        >
          Quitar responsable
        </button>
      )}
      {done && <span className="text-xs font-medium text-emerald-700">{done}</span>}
      {error && <span className="w-full text-xs text-rose-700">{error}</span>}
    </span>
  );
}

const RISK_FLOW: RiskStatus[] = ["NORMAL", "REVISION", "RETENIDO", "APROBADO", "BLOQUEADO"];

/** Casos de fraude: revisión humana (plan §2.14). */
export function FraudCaseActions({ id, riskStatus }: { id: string; riskStatus: RiskStatus }) {
  const { busy, error, done, patch } = usePatch();
  const [to, setTo] = useState<RiskStatus>(riskStatus);
  const [decision, setDecision] = useState("");
  return (
    <span className="flex flex-wrap items-center gap-2">
      <select value={to} onChange={(e) => setTo(e.target.value as RiskStatus)} className="rounded-md border border-stone-300 px-2 py-1.5 text-xs" aria-label="Nuevo estado de riesgo">
        {RISK_FLOW.map((s) => (
          <option key={s} value={s}>
            {statusLabel(s)}
          </option>
        ))}
      </select>
      <input
        value={decision}
        onChange={(e) => setDecision(e.target.value)}
        placeholder="Decisión / motivo de la revisión"
        className="w-56 rounded-md border border-stone-300 px-2 py-1.5 text-xs"
      />
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          patch(`/api/admin/fraud-cases/${id}`, { riskStatus: to, decision: decision.trim() || undefined }, "Caso actualizado.")
        }
        className="rounded-md bg-orange-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-orange-700 disabled:opacity-50"
      >
        {busy ? "…" : "Decidir"}
      </button>
      {done && <span className="text-xs font-medium text-emerald-700">{done}</span>}
      {error && <span className="w-full text-xs text-rose-700">{error}</span>}
    </span>
  );
}

/** Activar un país (gate legal + proveedor; 409 con motivo si no pasa). */
export function CountryActivateButton({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (status === "ACTIVO") return <span className="text-xs font-bold text-emerald-700">Activo</span>;
  return (
    <span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm("¿Activar este país? Se verifica el gate legal y de proveedor; si no pasa, la API lo rechaza con el motivo.")) return;
          setBusy(true);
          setError(null);
          try {
            const res = await clientApi(`/api/admin/countries/${id}/activate`, { method: "POST" });
            if (!res.ok) {
              setError(res.error);
              return;
            }
            router.refresh();
          } finally {
            setBusy(false);
          }
        }}
        className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {busy ? "…" : "Activar"}
      </button>
      {error && <span className="ml-2 text-xs text-rose-700">{error}</span>}
    </span>
  );
}
