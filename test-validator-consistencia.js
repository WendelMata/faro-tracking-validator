// Prova que identificador variando no mesmo produto é detectado.
// Antes: o produto era identificado por `item_id ?? item_sku ?? item_name`, então um
// item_id diferente criava uma entrada nova no mapa e a inconsistência era invisível.
'use strict';
const assert = require('node:assert/strict');
const { verificarConsistencia } = require('./validator');

const ev = (nome, item) => ({ event: { event: nome, ecommerce: { items: [item] } }, timestamp: 1 });

// 1) item_id muda entre view_item e add_to_cart; o item_ref não muda e denuncia
const caso1 = verificarConsistencia([
  ev('view_item',   { item_id: '332224', item_ref: '52.13.6753_0005', item_name: 'Regata' }),
  ev('add_to_cart', { item_id: '79177',  item_ref: '52.13.6753_0005', item_name: 'Regata' }),
]);
const achouItemId = caso1.some(i => i.campo === 'item_id' && i.valor_origem === '332224' && i.valor_atual === '79177');
console.log('1) item_id variando  ->', achouItemId ? 'DETECTADO' : 'PASSOU BATIDO', '|', caso1.length, 'inconsistência(s)');
assert.ok(achouItemId, 'item_id variando no mesmo produto deveria ser detectado');

// 2) item_ref em formatos diferentes; o item_id ancora o grupo
const caso2 = verificarConsistencia([
  ev('view_item',   { item_id: '1', item_ref: '07.20.8218_0005' }),
  ev('add_to_cart', { item_id: '1', item_ref: '072082180005P' }),
]);
console.log('2) item_ref em 2 formatos ->', caso2.length ? 'DETECTADO' : 'PASSOU BATIDO');
assert.equal(caso2.length, 1, 'formato divergente de item_ref deveria gerar 1 inconsistência');

// 3) index mudando NÃO é inconsistência (posição na lista varia de propósito)
const caso3 = verificarConsistencia([
  ev('view_item_list', { item_id: '1', index: 1 }),
  ev('view_cart',      { item_id: '1', index: 2 }),
]);
console.log('3) index 1 -> 2       ->', caso3.length === 0 ? 'ignorado (correto)' : 'FALSO POSITIVO');
assert.equal(caso3.length, 0, 'index é posicional e não pode gerar inconsistência');

// 4) price em unidade errada continua sendo pego
const caso4 = verificarConsistencia([
  ev('view_item', { item_id: '1', price: 178 }),
  ev('purchase',  { item_id: '1', price: 17800 }),
]);
console.log('4) price 178 vs 17800 ->', caso4.length ? 'DETECTADO' : 'PASSOU BATIDO');
assert.equal(caso4.length, 1, 'erro de unidade no price deve continuar sendo detectado');

// 5) produtos realmente diferentes não podem ser agrupados
const caso5 = verificarConsistencia([
  ev('view_item', { item_id: '1', item_ref: 'A', item_name: 'Blusa', item_variant: 'Preto' }),
  ev('view_item', { item_id: '2', item_ref: 'B', item_name: 'Blusa', item_variant: 'Branco' }),
]);
console.log('5) 2 produtos distintos ->', caso5.length === 0 ? 'não agrupou (correto)' : 'FALSO POSITIVO');
assert.equal(caso5.length, 0, 'cores diferentes do mesmo nome são produtos distintos');

console.log('');
console.log('OK — identificador variando é detectado, e index deixou de gerar ruído.');
