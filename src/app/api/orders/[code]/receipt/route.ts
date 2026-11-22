// GET /api/orders/[code]/receipt — comprobante del pedido.
// Devuelve un PDF BINARIO real (pdfkit) con código de pedido, rifa,
// números, monto, fecha, estado, QR de verificación y marca Prende
// Rifas. `?format=json` devuelve el JSON anterior (qrCode + qrPayload)
// para compatibilidad con clientes que imprimen el comprobante desde
// el frontend.
// S5: el PDF lo genera el servidor con pdfkit; el QR lo genera `qrcode`
// (ya instalado) y se incrusta como imagen PNG en el PDF.
import { NextRequest, NextResponse } from "next/server";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { errorResponse } from "@/lib/errors";
import { getOrderByCode, presentOrder } from "@/lib/orders";

function receiptJson(order: Awaited<ReturnType<typeof getOrderByCode>>, qrCode: string, qrPayload: string) {
  return {
    order: presentOrder(order),
    tickets: order.tickets.map((t) => ({
      id: t.id,
      number: t.number,
      code: t.code,
      status: t.status,
    })),
    payment: order.payments[0]
      ? {
          status: order.payments[0].status,
          methodCode: order.payments[0].methodCode,
          amount: order.payments[0].amount,
          currency: order.payments[0].currency,
        }
      : null,
    raffle: order.raffle,
    qrPayload,
    qrCode,
    issuedAt: new Date().toISOString(),
  };
}

async function buildReceiptPdf(order: Awaited<ReturnType<typeof getOrderByCode>>): Promise<Buffer> {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const qrPayload = `${appUrl}/api/orders/${order.code}`;
  const qrPng = await QRCode.toBuffer(qrPayload, { margin: 1, width: 256 });
  const payment = order.payments[0] ?? null;
  const numbers = order.tickets.map((t) => t.number).sort((a, b) => a - b);

  const doc = new PDFDocument({ size: "A4", margin: 56 });
  doc.info.Title = `Comprobante ${order.code} — Prende Rifas`;
  doc.info.Subject = `Pedido ${order.code}`;
  doc.info.Author = "Prende Rifas";
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.fontSize(22).fillColor("#111111").text("Prende Rifas", { align: "left" });
  doc.fontSize(13).fillColor("#555555").text("Comprobante de pedido", { align: "left" });
  doc.moveDown(0.5);
  doc.strokeColor("#cccccc").lineWidth(1).moveTo(56, doc.y).lineTo(539, doc.y).stroke();
  doc.moveDown(1);

  const row = (label: string, value: string) => {
    doc.fontSize(11).fillColor("#555555").text(label, { continued: true });
    doc.fontSize(11).fillColor("#111111").text(`  ${value}`);
    doc.moveDown(0.35);
  };
  row("Código de pedido:", order.code);
  row("Rifa:", order.raffle.title);
  row("Comprador:", `${order.buyerName} (${order.buyerEmail})`);
  row("Fecha:", new Date(order.createdAt).toLocaleString("es-DO", { timeZone: "America/Santo_Domingo" }));
  row("Estado del pedido:", order.status);
  row("Método de pago:", payment ? payment.methodCode : "—");
  row("Estado del pago:", payment ? payment.status : "—");
  row("Monto:", `${order.totalAmount} ${order.currency}`);
  doc.moveDown(0.5);
  doc.fontSize(12).fillColor("#111111").text("Boletos:");
  doc.fontSize(11).fillColor("#111111").text(numbers.length > 0 ? numbers.join(", ") : "—");
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#555555").text("Códigos de boleto:");
  for (const t of order.tickets) {
    doc.fontSize(10).fillColor("#333333").text(`  #${t.number} — ${t.code} (${t.status})`);
  }
  doc.moveDown(1);
  doc.fontSize(11).fillColor("#111111").text("Verifica tu pedido escaneando el código QR:");
  doc.moveDown(0.5);
  doc.image(qrPng, { width: 160 });
  doc.moveDown(1);
  doc.fontSize(9).fillColor("#888888").text("Prende Rifas — comprobante generado automáticamente. Verifica en " + qrPayload);
  doc.end();
  return done;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await params;
    const order = await getOrderByCode(code);
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const qrPayload = `${appUrl}/api/orders/${order.code}`;
    const qrCode = await QRCode.toDataURL(qrPayload, { margin: 1, width: 256 });

    if (req.nextUrl.searchParams.get("format") === "json") {
      return NextResponse.json(receiptJson(order, qrCode, qrPayload));
    }
    const pdf = await buildReceiptPdf(order);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="comprobante-${order.code}.pdf"`,
        "Content-Length": String(pdf.length),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
