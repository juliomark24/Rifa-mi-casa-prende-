import AuthForm from "@/components/AuthForm";

export default function RegistroAfiliadoPage() {
  return (
    <div>
      <AuthForm mode="register-afiliado" />
      <div className="mx-auto mt-6 max-w-md rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
        <h2 className="font-bold">¿Cómo funciona ser afiliado?</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Recibes un link de referido único, como <span className="font-mono">prenderifas.com/r/TU-CODIGO</span>.</li>
          <li>Compartes tu link en WhatsApp, Facebook, Instagram o donde quieras.</li>
          <li>Ganas <strong>10% de comisión</strong> por cada boleto vendido con tu link, solo sobre ventas pagadas.</li>
          <li>Sigues tus clics, ventas y saldo en tu panel y solicitas retiros cuando quieras.</li>
        </ul>
      </div>
    </div>
  );
}
