// Prova que o "custom_X" dos 7 eventos da lista fechada é validado MESMO quando o "X"
// nativo existe perto no tempo na mesma sessão. Antes, o custom_ virava 'ignorado' e só
// o nativo respondia — e como é o custom_ que carrega o payload completo no checkout, o
// defeito era carimbado no evento errado ou não aparecia. Medido no acervo: 577 de 1267
// pushes custom_ eram suprimidos assim, em 114 sessões.
'use strict';
const assert = require('node:assert/strict');
const { validateAll } = require('./validator');

const item = { item_id: '1', item_name: 'Blusa', price: 10, quantity: 1 }; // sem item_url/image_url
const ev = (nome, ts, regiao) => ({
  event: { event: nome, ecommerce: { region: regiao, brand: 'marca-a', currency: 'BRL', value: 10, items: [item] } },
  timestamp: ts,
});

const LISTA = ['view_cart', 'begin_checkout', 'add_shipping_info', 'add_payment_info', 'purchase'];

console.log('1) custom_ + nativo na mesma sessão -> os DOIS validam:');
for (const base of LISTA) {
  const r = validateAll([ev(base, 1000, 'checkout'), ev('custom_' + base, 1100, 'checkout')], []);
  const custom = r.eventos.find(e => e.event === 'custom_' + base);
  const nativo = r.eventos.find(e => e.event === base);
  console.log('     ', base.padEnd(20), 'custom_:', String(custom.status).padEnd(9), '| nativo:', nativo.status);
  assert.notEqual(custom.status, 'ignorado', 'custom_' + base + ' não pode ser suprimido pelo nativo');
  assert.notEqual(nativo.status, 'ignorado', base + ' nativo deve seguir validando');
  assert.ok(custom.errors.some(e => /item_url/.test(e)), 'custom_' + base + ' deve apontar o item_url ausente');
}

// add_to_cart e remove_from_cart: a forma custom_ só é canônica dentro do checkout
console.log('');
console.log('2) add_to_cart / remove_from_cart — só no checkout:');
for (const base of ['add_to_cart', 'remove_from_cart']) {
  const dentro = validateAll([ev(base, 1000, 'checkout'), ev('custom_' + base, 1100, 'checkout')], []);
  const cDentro = dentro.eventos.find(e => e.event === 'custom_' + base);
  assert.notEqual(cDentro.status, 'ignorado', 'custom_' + base + ' no checkout deve validar');

  const fora = validateAll([ev(base, 1000, 'pdp'), ev('custom_' + base, 1100, 'pdp')], []);
  const cFora = fora.eventos.find(e => e.event === 'custom_' + base);
  assert.equal(cFora.status, 'ignorado', 'custom_' + base + ' fora do checkout segue sendo alias do nativo');

  console.log('     ', base.padEnd(20), 'checkout:', String(cDentro.status).padEnd(9), '| pdp:', cFora.status);
}

// sem região declarada a regra continua valendo — a maioria desses pushes não traz region
const semReg = validateAll([ev('add_to_cart', 1000, undefined), ev('custom_add_to_cart', 1100, undefined)], []);
const cSem = semReg.eventos.find(e => e.event === 'custom_add_to_cart');
console.log('');
console.log('3) custom_add_to_cart sem region declarada ->', cSem.status === 'ignorado' ? 'SUPRIMIDO' : 'valida (correto)');
assert.notEqual(cSem.status, 'ignorado', 'região ausente não pode fazer a regra deixar de valer');

// Evento fora da lista fechada mantém o comportamento antigo (alias do nativo).
// "custom_view_item_list" NÃO é um evento válido — view_item_list não leva prefixo. Ele
// está aqui justamente porque aparece em produção por engano (144 pushes: marca-c 73,
// marca-h 36, marca-g 20, marca-a 15), então serve de caso real de algo que o validador
// não pode promover a disparo canônico só por ter o prefixo.
const foraLista = validateAll([ev('view_item_list', 1000, 'home'), ev('custom_view_item_list', 1100, 'home')], []);
const cForaLista = foraLista.eventos.find(e => e.event === 'custom_view_item_list');
console.log('4) custom_view_item_list (prefixo indevido) ->', cForaLista.status === 'ignorado' ? 'ignorado (correto)' : 'MUDOU');
assert.equal(cForaLista.status, 'ignorado', 'evento fora da lista fechada não pode mudar de comportamento');

console.log('');
console.log('OK — o custom_ dos 7 eventos deixou de ser engolido pelo nativo.');
