"use client";

import { useState } from "react";
import { clientApi } from "./clientApi";
import { supportTypeLabel } from "./format";
import type { SupportTicketType } from "./types";

/**
 * Crear ticket de soporte (público).
 *
 * TODO (hueco del contrato v2.2): el contrato solo define
 * GET /api/admin/support-tickets y PATCH /api/admin/support-tickets/[id]
 * (admin). No define el endpoint público para crear un ticket ni para
 * listar "mis tickets". Este formulario intenta POST /api/support-tickets;
 * si el backend aún no lo expone, la API responde 404 y se muestra un
 * mensaje claro en vez de fingir que el ticket se creó.
 */
const TYPES: SupportTicketType[] = [
  "PAGO_SIN_BOLETO",
  "CONSULTA_BOLETO",
  "PAGO_RECHAZADO",
  "PROBLEMA_COMPRA",
  "DEVOLUCION",
  "DUDA_GANADOR",
  "OTRO",
];

export default function SupportTicketForm() {
  const [type, setType] = useState<SupportTicketType>("PAGO_SIN_BOLETO");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [orderCode, setOrderCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      const res = await clientApi<{ caseNumber?: string; id?: string }>("/api/support-tickets", {
        method: "POST",
        body: JSON.stringify({
          type,
          subject: subject.trim(),
          description: description.trim(),
          buyerName: name.trim(),
          buyerEmail: email.trim(),
          orderCode: orderCode.trim() || undefined,
        }),
      });
      if (!res.ok) {
        setError(
          res.status === 404
            ? "El centro de soporte aún no está disponible en el servidor (el endpoint público de tickets no está expuesto todavía). Escríbenos por el correo de contacto mientras tanto."
            : res.error
        );
        return;
      }
      setSuccess(
        `Ticket creado${res.data?.caseNumber ? ` con número de caso ${res.data.caseNumber}` : ""}. Te responderemos por correo.`
      );
      setSubject("");
      setDescription("");
      setOrderCode("");
    } finally {
      setLoading(false);
    }
  }

  const inputCls = "mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm";
  return (
    <form onSubmit={handleSubmit} className="mt-5 grid gap-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:grid-cols-2">
      <label className="block text-sm font-medium text-stone-700">
        Tipo de reclamación *
        <select value={type} onChange={(e) => setType(e.target.value as SupportTicketType)} className={inputCls}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {supportTypeLabel(t)}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-medium text-stone-700">
        Código de orden (si aplica)
        <input value={orderCode} onChange={(e) => setOrderCode(e.target.value)} className={inputCls} placeholder="Ej. PR-2026-0001" />
      </label>
      <label className="block text-sm font-medium text-stone-700">
        Nombre completo *
        <input required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Tu nombre" />
      </label>
      <label className="block text-sm font-medium text-stone-700">
        Correo electrónico *
        <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="tu@correo.com" />
      </label>
      <label className="block text-sm font-medium text-stone-700 sm:col-span-2">
        Asunto *
        <input required value={subject} onChange={(e) => setSubject(e.target.value)} className={inputCls} placeholder="Resumen corto de tu caso" />
      </label>
      <label className="block text-sm font-medium text-stone-700 sm:col-span-2">
        Describe lo que pasó *
        <textarea required rows={4} value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} placeholder="Cuéntanos qué pasó, con fechas y montos si los tienes." />
      </label>
      {error && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 sm:col-span-2" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 sm:col-span-2" role="status">
          {success}
        </p>
      )}
      <div className="sm:col-span-2">
        <button type="submit" disabled={loading} className="rounded-lg bg-orange-600 px-6 py-2.5 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50">
          {loading ? "Enviando…" : "Crear ticket"}
        </button>
      </div>
    </form>
  );
}
