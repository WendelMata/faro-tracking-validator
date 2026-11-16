// Prova que validateAll não estoura nas duas entradas que derrubavam a validação inteira.
// Antes: o TypeError subia até o catch de /api/save-session, que gravava resumo zerado e
// eventos vazios — e o relatório carimbava "✅ Aprovado" numa sessão nunca validada.
'use strict';
const assert = require('node:assert/strict');
const { validateAll } = require('./validator');

function naoEstoura(rotulo, dlEvents, ga4Events = []) {
  try {
    const r = validateAll(dlEvents, ga4Events);
    console.log('OK ', rotulo, '-> total:', r.summary.total);
    return r;
  } catch (e) {
    console.log('FALHOU', rotulo, '->', e.constructor.name + ':', e.message);
    throw e;
  }
}

// 1) push de dataLayer sem a chave `event` — o nome vira o objeto inteiro
naoEstoura('push sem chave event', [{ event: { ecommerce: { items: [] } }, timestamp: 1 }]);

// 2) items chegando serializado como JSON-string (captura ADB)
const r2 = naoEstoura('items como JSON-string', [{
  event: {
    event: 'view_item',
    ecommerce: { region: 'pdp', brand: 'marca-f', items: '[{"item_id":"1","item_name":"Blusa"}]' },
  },
  timestamp: 1,
}]);
// e os itens de dentro da string passam a ser realmente checados
const ev2 = r2.eventos[0];
const mencionaItem = [...ev2.errors, ...ev2.passed].some(m => m.startsWith('items[0]'));
assert.ok(mencionaItem, 'os itens vindos como string deveriam ser checados, não ignorados');

// 3) items como lixo (número, objeto) — não checa nada, mas não derruba
naoEstoura('items como número', [{ event: { event: 'view_item', ecommerce: { items: 42 } }, timestamp: 1 }]);
naoEstoura('items como objeto', [{ event: { event: 'view_item', ecommerce: { items: { a: 1 } } }, timestamp: 1 }]);

// 4) evento totalmente vazio
naoEstoura('evento vazio', [{ event: {}, timestamp: 1 }]);

console.log('');
console.log('OK — nenhuma dessas entradas derruba a validação.');
