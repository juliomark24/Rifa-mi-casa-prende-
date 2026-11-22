#!/usr/bin/env node
// verify-draw.mjs — Verificación INDEPENDIENTE del sorteo PRENDE RIFAS.
// Reproduce el ganador sin el servidor y sin dependencias (solo node:crypto).
// Implementación propia del algoritmo publicado "SHA256-CHAIN-v1"; no importa
// código de src/lib/draw.ts, para que la comparación lib-vs-script sea real.
//
// Uso:
//   node scripts/verify-draw.mjs sorteo.json
//   cat sorteo.json | node scripts/verify-draw.mjs
//
// Entrada JSON (una de las dos formas de lista):
//   {
//     "seed": "<semilla revelada, hex>",
//     "eligibleSnapshot": "[1,3,5]",          // lista congelada canónica
//     // ...o bien "eligible": [1, 3, 5],
//     "commitment": "<SHA256 publicado antes del sorteo>",
//     "winnerNumber": 3,                      // ganador publicado
//     // alias aceptados: "winnerTicketNumber"
//   }
//
// Algoritmo (idéntico al publicado en el plan §2.5):
//   snapshot canónico = JSON compacto de los números únicos ordenados.
//   hashElegibles     = SHA256(snapshot)
//   commitment        = SHA256("<seed>:<hashElegibles>")
//   digest            = SHA256("<seed>:<hashElegibles>")
//   winnerIndex       = (primeros 8 bytes del digest como entero) % total
//   ganador           = elegibles[winnerIndex]
//
// Salida: VERIFICADO (exit 0) o NO COINCIDE (exit 1), con el detalle.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function serializeEligible(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  return JSON.stringify(sorted);
}

function fail(message) {
  console.log(`NO COINCIDE: ${message}`);
  process.exit(1);
}

async function readInput() {
  const file = process.argv[2];
  if (file && file !== "--help" && file !== "-h") {
    return readFileSync(file, "utf8");
  }
  if (file === "--help" || file === "-h") {
    console.log(
      "Uso: node scripts/verify-draw.mjs [sorteo.json]\n" +
        "Sin archivo, lee el JSON por stdin. La entrada lleva seed, " +
        "eligibleSnapshot (o eligible), commitment y winnerNumber.",
    );
    process.exit(0);
  }
  // stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await readInput();
let input;
try {
  input = JSON.parse(raw);
} catch {
  fail("la entrada no es JSON válido");
}

const seed = input.seed;
const commitment = input.commitment;
const expectedWinner = input.winnerNumber ?? input.winnerTicketNumber;
if (typeof seed !== "string" || seed.length === 0) fail("falta la semilla revelada (seed)");
if (typeof commitment !== "string" || commitment.length === 0) fail("falta el compromiso publicado (commitment)");
if (!Number.isInteger(expectedWinner)) fail("falta el número ganador publicado (winnerNumber)");

let snapshot;
if (typeof input.eligibleSnapshot === "string") {
  snapshot = input.eligibleSnapshot;
} else if (Array.isArray(input.eligible)) {
  snapshot = serializeEligible(input.eligible);
} else {
  fail("falta la lista congelada (eligibleSnapshot o eligible)");
}

let eligible;
try {
  eligible = JSON.parse(snapshot);
} catch {
  fail("eligibleSnapshot no es JSON válido");
}
if (!Array.isArray(eligible) || eligible.length === 0) fail("la lista congelada está vacía");
if (!eligible.every((n) => Number.isInteger(n))) fail("la lista congelada tiene números no enteros");
if (serializeEligible(eligible) !== snapshot) {
  fail("la lista congelada no está en formato canónico (números únicos ordenados, JSON compacto)");
}

const hashElegibles = sha256Hex(snapshot);
const computedCommitment = sha256Hex(`${seed}:${hashElegibles}`);
const digest = sha256Hex(`${seed}:${hashElegibles}`);
const winnerIndex = Number(BigInt(`0x${digest.slice(0, 16)}`) % BigInt(eligible.length));
const winnerNumber = eligible[winnerIndex];

console.log(`Algoritmo:        SHA256-CHAIN-v1`);
console.log(`Total elegibles:  ${eligible.length}`);
console.log(`Hash elegibles:   ${hashElegibles}`);
console.log(`Compromiso calc.: ${computedCommitment}`);
console.log(`Compromiso publ.: ${commitment}`);
console.log(`Compromiso OK:    ${computedCommitment === commitment ? "sí" : "NO"}`);
console.log(`Índice ganador:   ${winnerIndex}`);
console.log(`Ganador calc.:    #${winnerNumber}`);
console.log(`Ganador publ.:    #${expectedWinner}`);

if (computedCommitment !== commitment) {
  fail("el compromiso no coincide (semilla o lista alteradas)");
}
if (winnerNumber !== expectedWinner) {
  fail(`el ganador reproducido (#${winnerNumber}) no coincide con el publicado (#${expectedWinner})`);
}
console.log(`VERIFICADO: el sorteo reproduce el ganador publicado #${winnerNumber}`);
process.exit(0);
