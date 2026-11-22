import { redirect } from "next/navigation";
import { getSession } from "@/components/api";
import { isAdminRole } from "@/components/types";
import AdminNav from "@/components/AdminNav";

/** Layout admin: solo roles administrativos (verificado en el servidor en cada carga). */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!isAdminRole(session.role)) redirect("/");

  return (
    <div className="grid gap-6 md:grid-cols-[220px_1fr]">
      <aside className="md:sticky md:top-20 md:self-start">
        <h1 className="mb-3 px-1 text-lg font-black text-stone-900">Administración</h1>
        <AdminNav />
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
