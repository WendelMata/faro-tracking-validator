// Prova que a comparação DL↔GA4 enxerga os campos de item que a lista fixa omitia
// (item_url, image_url, item_ref, item_sku) e que hit sem nenhum item vira divergência.
// Usa purchase@Checkout, que é onde o schema declara esses campos como items[].* — e é
// o evento da auditoria de item_url no checkout.
'use strict';
const assert = require('node:assert/strict');
const { compararDLvsGA4 } = require('./validator');

const dl  = (items) => ({ event: { event: 'purchase', ecommerce: { region: 'checkout', brand: 'marca-f', items } }, timestamp: 1000 });
const ga4 = (params) => ({ event: { event_name: 'purchase', params, timestamp: 1050 }, timestamp: 1050 });

// 1) campos de item presentes no DL e ausentes no GA4
const itemDL  = { item_id: '1', item_name: 'Blusa', item_url: 'https://x/p', image_url: 'https://x/i.jpg', item_ref: 'R1', item_sku: '77' };
const itemGA4 = { item_id: '1', item_name: 'Blusa' };

const divs1 = (compararDLvsGA4([dl([itemDL])], [ga4({ items: [itemGA4] })], {})[0]?.divergencias ?? []).join(' | ');
console.log('1) campos que a lista fixa omitia:');
for (const campo of ['item_url', 'image_url', 'item_ref', 'item_sku']) {
  const achou = divs1.includes('.' + campo + ':');
  console.log('     ', campo.padEnd(12), achou ? 'DETECTADO' : 'passou batido');
  assert.ok(achou, campo + ' deveria gerar divergência');
}

// 2) GA4 sem nenhum item enquanto o DL trazia 3
const divs2 = (compararDLvsGA4(
  [dl([{ item_id: '1' }, { item_id: '2' }, { item_id: '3' }])],
  [ga4({ currency: 'BRL', value: 10 })],
  {},
)[0]?.divergencias ?? []).join(' | ');
console.log('');
console.log('2) DL com 3 itens, GA4 com zero ->', divs2.includes('não recebeu nenhum') ? 'DETECTADO' : 'PASSOU BATIDO');
assert.ok(divs2.includes('não recebeu nenhum'), 'hit sem itens deveria gerar divergência');

console.log('');
console.log('OK — a comparação deixou de ser cega nos campos mais auditados.');
