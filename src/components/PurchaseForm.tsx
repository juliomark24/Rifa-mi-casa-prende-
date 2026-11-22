"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatMoney } from "./format";
import { clientApi } from "./clientApi";
import { newIdempotencyKey } from "./types";
import type { PaymentMethod, PurchaseResult, Raffle, Reservation } from "./types";

/**
 * Selector de números + flujo de compra en dos pasos (contrato v2.2):
 *  1. POST /api/raffles/[id]/reserve {numbers?, quantity?, buyerEmail}
 *     → reserva ~10 min (reservationId, expiresAt, numbers).
 *  2. POST /api/raffles/[id]/purchase {reservationId, paymentMethodCode,
 *     affiliateCode?, buyerName, buyerEmail, buyerPhone?} con
 *     Idempotency-Key → {order, tickets, paymentInstructions?}.
 *
 * Métodos de pago: GET /api/payment-methods?country= (solo los habilitados
 * para el país de la rifa; nunca se muestra un método no habilitado).
 * El servidor es la única autoridad de disponibilidad: un 409 en la
 * reserva significa que un número ya no está disponible.
 *
 * NOTA (S9-int): el detalle de la rifa trae `soldNumbers` Y
 * `reservedNumbers` (contrato v2.2): los reservados por otro comprador se
 * muestran como no disponibles hasta que la reserva responde 409. El
 * servidor sigue siendo la única autoridad de disponibilidad.
 */
const QUICK = [1, 5, 10, 20];

function ReservationTimer({ expiresAt, onExpire }: { expiresAt: string; onExpire: () => void }) {
  const [left, setLeft] = useState(() => Math.max(0, new Date(expiresAt).getTime() - Date.now()));
  useEffect(() => {
    const id = setInterval(() => {
      const ms = new Date(expiresAt).getTime() - Date.now();
      setLeft(Math.max(0, ms));
      if (ms <= 0) {
        clearInterval(id);
        onExpire();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt, onExpire]);
  const total = Math.floor(left / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return (
    <span className="rounded-lg bg-amber-100 px-3 py-1.5 font-mono text-sm font-bold text-amber-900" role="timer">
      Reserva válida: {mm}:{ss}
    </span>
  );
}

export default function PurchaseForm({ raffle }: { raffle: Raffle }) {
  const sold = useMemo(() => new Set(raffle.soldNumbers ?? []), [raffle.soldNumbers]);
  // Números reservados por otros compradores (contrato v2.2): no se pueden
  // elegir; se muestran en ámbar hasta que la reserva venza o se compre.
  const reservedByOthers = useMemo(() => new Set(raffle.reservedNumbers ?? []), [raffle.reservedNumbers]);
  const [selected, setSelected] = useState<number[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [mode, setMode] = useState<"choose" | "random">("choose");
  const [buyerName, setBuyerName] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [affiliateCode, setAffiliateCode] = useState("");
  // Aceptación de las bases vigentes (contrato v2.2): la compra la envía
  // como `acceptTerms: true`; sin ella el servidor rechaza la compra.
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [methodsLoading, setMethodsLoading] = useState(true);
  const [methodsError, setMethodsError] = useState<string | null>(null);
  const [paymentCode, setPaymentCode] = useState<string>("");
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PurchaseResult | null>(null);

  // Métodos habilitados para el país de la rifa (checkout dinámico).
  useEffect(() => {
    let cancelled = false;
    clientApi<{ data?: PaymentMethod[] } | PaymentMethod[]>(`/api/payment-methods?country=${encodeURIComponent(raffle.country)}`)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setMethodsError(res.error);
          setMethodsLoading(false);
          return;
        }
        const list = Array.isArray(res.data) ? res.data : ((res.data as { data?: PaymentMethod[] }).data ?? []);
        const enabled = list.filter((m) => m.enabled !== false);
        setMethods(enabled);
        if (enabled.length > 0) setPaymentCode(enabled[0].code);
        setMethodsLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setMethodsError("No se pudieron cargar los métodos de pago.");
          setMethodsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [raffle.country]);

  // Código de referido guardado por /r/[code] en la cookie pr_ref (30 días).
  useEffect(() => {
    const match = document.cookie.match(/(?:^|;\s*)pr_ref=([^;]+)/);
    if (match) setAffiliateCode(decodeURIComponent(match[1]));
  }, []);

  const count = mode === "choose" ? selected.length : quantity;
  const total = count * raffle.ticketPrice;
  // Disponibles reales: ni vendidos ni reservados por otros (la API ya
  // trae availableCount; si falta, se calcula con ambos conjuntos).
  const available = raffle.availableCount ?? raffle.totalTickets - sold.size - reservedByOthers.size;
  const reservedNumbers = reservation?.numbers ?? selected;

  function toggle(n: number) {
    if (sold.has(n) || reservedByOthers.has(n)) return;
    setSelected((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]));
  }

  function pickQuick(n: number) {
    setMode("random");
    setQuantity(Math.min(n, Math.max(1, available)));
  }

  async function handleReserve(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "choose" && selected.length === 0) {
      setError("Elige al menos un número disponible.");
      return;
    }
    if (mode === "random" && quantity < 1) {
      setError("La cantidad debe ser al menos 1.");
      return;
    }
    if (!buyerEmail.trim()) {
      setError("Escribe tu correo electrónico para reservar los boletos.");
      return;
    }
    setLoading(true);
    try {
      const body: Record<string, unknown> = { buyerEmail: buyerEmail.trim() };
      if (mode === "choose") body.numbers = selected;
      else body.quantity = quantity;
      const res = await clientApi<Reservation>(`/api/raffles/${raffle.id}/reserve`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // 409: número ya no disponible (el mensaje del servidor puede traer
        // sugerencia de números cercanos).
        setError(res.error);
        return;
      }
      setReservation(res.data);
      setSelected([...res.data.numbers].sort((a, b) => a - b));
    } finally {
      setLoading(false);
    }
  }

  async function handlePurchase(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!reservation) {
      setError("Primero reserva tus boletos.");
      return;
    }
    if (!buyerName.trim() || !buyerEmail.trim()) {
      setError("Completa tu nombre y tu correo electrónico.");
      return;
    }
    if (!paymentCode) {
      setError("Elige un método de pago.");
      return;
    }
    if (!acceptTerms) {
      setError("Debes aceptar las bases de la rifa para comprar.");
      return;
    }
    setLoading(true);
    try {
      const res = await clientApi<PurchaseResult>(`/api/raffles/${raffle.id}/purchase`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        body: JSON.stringify({
          reservationId: reservation.reservationId,
          paymentMethodCode: paymentCode,
          affiliateCode: affiliateCode.trim() || undefined,
          buyerName: buyerName.trim(),
          buyerEmail: buyerEmail.trim(),
          buyerPhone: buyerPhone.trim() || undefined,
          acceptTerms: true,
        }),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResult(res.data);
    } finally {
      setLoading(false);
    }
  }

  function handleExpire() {
    setReservation(null);
    setError("Tu reserva venció y los números volvieron a estar disponibles. Vuelve a reservar para comprar.");
  }

  if (raffle.status !== "ACTIVA") {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Esta rifa no está activa en este momento, por lo que no se pueden comprar boletos.
      </div>
    );
  }

  if (result) {
    const instructions = result.paymentInstructions;
    const tickets = result.tickets ?? [];
    const isManual = result.order.paymentMethodCode === "MANUAL_TRANSFER";
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
        <h3 className="text-lg font-bold text-emerald-900">¡Compra registrada!</h3>
        <p className="mt-1 text-sm text-emerald-800">
          Orden <strong className="font-mono">{result.order.code}</strong> · Estado:{" "}
          <strong>{result.order.status === "PENDIENTE" ? "pendiente de pago" : result.order.status}</strong>.
        </p>
        {tickets.length > 0 && (
          <p className="mt-2 text-sm text-emerald-800">
            Boletos: <strong className="font-mono">{tickets.map((t) => `#${t.number} (${t.code})`).join(", ")}</strong>
          </p>
        )}
        {isManual && instructions && (
          <div className="mt-3 rounded-xl bg-white p-4 text-sm text-stone-700">
            <p className="font-bold text-stone-900">Instrucciones de transferencia</p>
            {typeof instructions === "string" ? (
              <p className="mt-1 whitespace-pre-line">{instructions}</p>
            ) : (
              <dl className="mt-1 space-y-1">
                {instructions.label && (
                  <div>
                    <dt className="inline font-semibold">Método: </dt>
                    <dd className="inline">{String(instructions.label)}</dd>
                  </div>
                )}
                {instructions.details && (
                  <p className="whitespace-pre-line">{String(instructions.details)}</p>
                )}
                {instructions.amount !== undefined && (
                  <div>
                    <dt className="inline font-semibold">Monto a transferir: </dt>
                    <dd className="inline font-mono">
                      {formatMoney(Number(instructions.amount), result.order.currency ?? raffle.currency)}
                    </dd>
                  </div>
                )}
                {instructions.reference && (
                  <div>
                    <dt className="inline font-semibold">Referencia: </dt>
                    <dd className="inline font-mono">{String(instructions.reference)}</dd>
                  </div>
                )}
              </dl>
            )}
            <p className="mt-2 text-xs text-stone-500">
              Tu orden queda pendiente hasta que un administrador confirme la transferencia. Guarda el código de tu orden.
            </p>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href={`/api/orders/${encodeURIComponent(result.order.code)}/receipt`}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
          >
            Descargar comprobante (PDF)
          </a>
          <Link href="/verificar" className="rounded-lg border border-emerald-300 px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-100">
            Verificar mis boletos
          </Link>
          <Link href="/mis-boletos" className="rounded-lg border border-emerald-300 px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-100">
            Ver en Mis boletos
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-bold text-stone-900">Comprar boletos</h2>
      <p className="mt-1 text-sm text-stone-600">
        {formatMoney(raffle.ticketPrice, raffle.currency)} por boleto · Sorteo:{" "}
        {new Date(raffle.drawAt).toLocaleDateString("es-DO", { day: "2-digit", month: "short", year: "numeric" })}
      </p>

      {reservation ? (
        <form onSubmit={handlePurchase} className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-50 px-3 py-2">
            <p className="text-sm font-semibold text-amber-900">
              Boletos reservados: <span className="font-mono">{[...reservedNumbers].sort((a, b) => a - b).join(", ")}</span>
            </p>
            <ReservationTimer expiresAt={reservation.expiresAt} onExpire={handleExpire} />
          </div>
          <p className="mt-2 text-xs text-stone-500">
            Completa el pago antes de que venza la reserva; si vence, los números vuelven a estar disponibles.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-stone-700">
              Nombre completo *
              <input required value={buyerName} onChange={(e) => setBuyerName(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2" placeholder="Tu nombre" />
            </label>
            <label className="block text-sm font-medium text-stone-700">
              Correo electrónico *
              <input required type="email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2" placeholder="tu@correo.com" />
            </label>
            <label className="block text-sm font-medium text-stone-700">
              Teléfono / WhatsApp
              <input value={buyerPhone} onChange={(e) => setBuyerPhone(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2" placeholder="+1 809 000 0000" />
            </label>
            <label className="block text-sm font-medium text-stone-700">
              Código de referido (opcional)
              <input value={affiliateCode} onChange={(e) => setAffiliateCode(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2" placeholder="Ej. PRENDE-ABC123" />
            </label>
            <label className="block text-sm font-medium text-stone-700 sm:col-span-2">
              Método de pago * ({raffle.country} · {raffle.currency})
              {methodsLoading ? (
                <span className="mt-1 block text-sm text-stone-500">Cargando métodos de pago…</span>
              ) : methodsError ? (
                <span className="mt-1 block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{methodsError}</span>
              ) : methods.length === 0 ? (
                <span className="mt-1 block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  No hay métodos de pago habilitados para {raffle.country} en este momento.
                </span>
              ) : (
                <select value={paymentCode} onChange={(e) => setPaymentCode(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2">
                  {methods.map((m) => (
                    <option key={m.id ?? m.code} value={m.code}>
                      {m.label} ({m.code})
                    </option>
                  ))}
                </select>
              )}
              {paymentCode === "MANUAL_TRANSFER" && (
                <span className="mt-1 block text-xs text-stone-500">Tu orden quedará pendiente hasta que un administrador confirme la transferencia.</span>
              )}
            </label>
          </div>

          {error && (
            <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800" role="alert">
              {error}
            </p>
          )}

          <label className="mt-4 flex items-start gap-2 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm text-stone-700">
            <input
              type="checkbox"
              required
              checked={acceptTerms}
              onChange={(e) => setAcceptTerms(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-orange-600"
            />
            <span>
              Acepto las bases de la rifa vigentes
              {raffle.termsVersionId ? ` (versión ${raffle.termsVersionId.slice(0, 8)})` : ""} y confirmo que
              cumplo las condiciones de participación.
            </span>
          </label>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-4">
            <p className="text-sm text-stone-700">
              Total: <strong className="text-lg text-stone-900">{formatMoney(total, raffle.currency)}</strong>
              <span className="text-stone-500"> ({count} boleto{count === 1 ? "" : "s"})</span>
            </p>
            <span className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setReservation(null);
                  setError(null);
                }}
                className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-100"
              >
                Cambiar números
              </button>
              <button
                type="submit"
                disabled={loading || !paymentCode || methods.length === 0}
                className="rounded-lg bg-orange-600 px-6 py-2.5 text-sm font-bold text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? "Procesando…" : "Pagar ahora"}
              </button>
            </span>
          </div>
        </form>
      ) : (
        <form onSubmit={handleReserve} className="mt-4">
          <div className="flex flex-wrap gap-2 text-sm">
            <button type="button" onClick={() => setMode("choose")} className={`rounded-lg px-3 py-2 font-semibold ${mode === "choose" ? "bg-orange-600 text-white" : "bg-stone-100 text-stone-700"}`}>
              Elegir mis números
            </button>
            <button type="button" onClick={() => setMode("random")} className={`rounded-lg px-3 py-2 font-semibold ${mode === "random" ? "bg-orange-600 text-white" : "bg-stone-100 text-stone-700"}`}>
              Números al azar
            </button>
            <span className="ml-auto flex gap-1.5">
              {QUICK.map((n) => (
                <button key={n} type="button" onClick={() => pickQuick(n)} className="rounded-lg bg-stone-100 px-2.5 py-2 text-xs font-bold text-stone-700 hover:bg-amber-100">
                  {n}
                </button>
              ))}
              <span className="self-center text-xs text-stone-400">compra rápida</span>
            </span>
          </div>

          {mode === "choose" ? (
            <div className="mt-4">
              <p className="text-xs text-stone-500">
                {available} disponibles de {raffle.totalTickets}. Los números en gris ya están vendidos; los de
                ámbar están reservados por otro comprador en este momento.
              </p>
              <div className="mt-2 grid max-h-64 grid-cols-8 gap-1.5 overflow-y-auto rounded-lg border border-stone-200 bg-stone-50 p-3 sm:grid-cols-10">
                {Array.from({ length: raffle.totalTickets }, (_, i) => i + 1).map((n) => {
                  const isSold = sold.has(n);
                  const isReserved = !isSold && reservedByOthers.has(n);
                  const isSel = selected.includes(n);
                  return (
                    <button
                      key={n}
                      type="button"
                      disabled={isSold || isReserved}
                      onClick={() => toggle(n)}
                      aria-pressed={isSel}
                      title={isSold ? "Vendido" : isReserved ? "Reservado por otro comprador" : `Número ${n}`}
                      className={`rounded-md py-1.5 text-xs font-bold ${
                        isSold
                          ? "cursor-not-allowed bg-stone-200 text-stone-400 line-through"
                          : isReserved
                            ? "cursor-not-allowed bg-amber-100 text-amber-700"
                            : isSel
                              ? "bg-orange-600 text-white"
                              : "bg-white text-stone-700 ring-1 ring-stone-300 hover:ring-orange-500"
                      }`}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
              {selected.length > 0 && (
                <p className="mt-2 text-sm text-stone-700">
                  Elegidos: <strong className="font-mono">{selected.sort((a, b) => a - b).join(", ")}</strong>
                </p>
              )}
            </div>
          ) : (
            <label className="mt-4 block text-sm font-medium text-stone-700">
              Cantidad de boletos
              <input
                type="number"
                min={1}
                max={Math.max(1, available)}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                className="mt-1 w-32 rounded-lg border border-stone-300 px-3 py-2"
              />
              <span className="ml-2 text-xs text-stone-500">Se asignan al azar entre los disponibles.</span>
            </label>
          )}

          <label className="mt-4 block text-sm font-medium text-stone-700">
            Correo electrónico * (para reservar y enviarte tus boletos)
            <input required type="email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2" placeholder="tu@correo.com" />
          </label>

          {error && (
            <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800" role="alert">
              {error}
            </p>
          )}

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-4">
            <p className="text-sm text-stone-700">
              Total: <strong className="text-lg text-stone-900">{formatMoney(total, raffle.currency)}</strong>
              <span className="text-stone-500"> ({count} boleto{count === 1 ? "" : "s"})</span>
            </p>
            <button
              type="submit"
              disabled={loading || count === 0}
              className="rounded-lg bg-orange-600 px-6 py-2.5 text-sm font-bold text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Reservando…" : "Reservar mis boletos"}
            </button>
          </div>
          <p className="mt-2 text-xs text-stone-500">
            La reserva dura unos 10 minutos. Si no completas el pago a tiempo, los números vuelven a estar disponibles.
          </p>
        </form>
      )}
    </div>
  );
}
