import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/Navbar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Prende Rifas — Rifas digitales con premios reales",
  description:
    "Compra boletos, verifica tu número y gana. Rifas digitales transparentes: sorteo con semilla y hash públicos.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-stone-50 text-stone-900">
        <Navbar />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
        <footer className="border-t border-stone-200 bg-white py-6">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 text-sm text-stone-500">
            <span>
              <strong className="text-stone-800">PRENDE RIFAS</strong> — Rifas digitales con sorteo transparente.
            </span>
            <span className="flex gap-4">
              <a href="/verificar" className="hover:text-orange-600">
                Verificar boleto
              </a>
              <a href="/ganadores" className="hover:text-orange-600">
                Ganadores
              </a>
              <a href="/soporte" className="hover:text-orange-600">
                Soporte
              </a>
              <a href="/registro-afiliado" className="hover:text-orange-600">
                Ser afiliado
              </a>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
