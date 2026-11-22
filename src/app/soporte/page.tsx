import SupportTicketForm from "@/components/SupportTicketForm";

/**
 * Centro de soporte (plan §2.17): crear un ticket de reclamación.
 *
 * TODO (hueco del contrato): el contrato v2.2 no define endpoint público
 * para listar "mis tickets" (solo GET /api/admin/support-tickets para
 * admin). La sección de seguimiento se añade cuando el backend exponga
 * esa consulta; por ahora el cliente recibe el número de caso y la
 * respuesta por correo.
 */
export default function SupportPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-black text-stone-900">Soporte</h1>
      <p className="mt-1 text-sm text-stone-600">
        ¿Paguaste y no recibiste tu boleto? ¿Tu pago fue rechazado? ¿Tienes dudas sobre un ganador? Crea un ticket y
        te respondemos. Cada ticket tiene un número de caso único y un historial completo.
      </p>

      <SupportTicketForm />

      <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5 text-sm text-stone-600 shadow-sm">
        <h2 className="font-bold text-stone-900">Seguimiento de mi ticket</h2>
        <p className="mt-1">
          Cuando crees tu ticket recibirás el número de caso y la respuesta por correo. La consulta de tickets por
          correo aún no está expuesta por la API (hueco del contrato v2.2); mientras tanto, responde al correo que
          recibas para seguir tu caso.
        </p>
        <p className="mt-2">
          También puedes verificar tu boleto en <a href="/verificar" className="font-semibold text-orange-600 hover:underline">Verificar boleto</a> o
          consultar el resultado de un sorteo en <a href="/ganadores" className="font-semibold text-orange-600 hover:underline">Ganadores</a>.
        </p>
      </div>
    </div>
  );
}
