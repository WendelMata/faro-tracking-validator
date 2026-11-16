// Prova que a falha do lado GA4 chega ao resumo de validateAll.
// Antes do conserto: uma sessão em que o hit chegou ao GA4 sem nenhum parâmetro saía
// com summary.failed = 0, e o relatório carimbava "✅ Aprovado" (server.js:912).
// O veredito por evento (result.status) continua sendo só do dataLayer, de propósito —
// o comentário em validator.js:456 diz que os dois lados são independentes.
'use strict';
const assert = require('node:assert/strict');
const { validateAll } = require('./validator');

// view_item íntegro no dataLayer…
const dlEvents = [{
  event: {
    event: 'view_item',
    ecommerce: {
      region: 'pdp', brand: 'marca-f', currency: 'BRL', value: 100,
      line_items: '1', available_grid: 'P,M,G',
      items: [{
        item_id: '1', item_name: 'Blusa', item_brand: 'Farm', item_category: 'Roupas',
        item_category2: 'Blusa', item_variant: 'Preto', item_variant2: 'M',
        item_ref: '1_0005', item_sku: '1', price: 100, discount: 0, quantity: 1,
        index: 1, item_url: 'https://x/p', image_url: 'https://x/i.jpg',
      }],
    },
  },
  timestamp: 1000,
}];

// …e o hit correspondente chegando ao GA4 completamente vazio.
const ga4Events = [{ event: { event_name: 'view_item', params: {}, timestamp: 1100 }, timestamp: 1100 }];

const r = validateAll(dlEvents, ga4Events);
const ev = r.eventos[0];

console.log('lado dataLayer  : status =', ev.status, '| erros =', ev.errors.length);
console.log('lado GA4        : status =', ev.ga4.status, '| erros =', ev.ga4.errors.length);
console.log('resumo          :', JSON.stringify(r.summary));
console.log('');

// O lado DL está correto e deve continuar passando — não é isso que mudou.
assert.equal(ev.status, 'passou', 'o lado dataLayer está íntegro e deve continuar passando');
assert.equal(ev.ga4.status, 'falhou', 'o lado GA4 deveria estar reprovado');
assert.ok(ev.ga4.errors.length > 0, 'o lado GA4 deveria ter erros');

// O que o conserto garante: a falha do GA4 aparece no resumo.
assert.ok('ga4Failed' in r.summary, 'summary deveria expor ga4Failed');
assert.equal(r.summary.ga4Failed, 1, 'a falha do GA4 deveria ser contada no resumo');

// E o critério de "Aprovado" do relatório (server.js:912) passa a enxergá-la.
const aprovado = (r.summary.failed === 0) && ((r.summary.ga4Failed ?? 0) === 0);
assert.equal(aprovado, false, 'uma sessão sem nada no GA4 não pode sair como Aprovado');

console.log('OK — falha do GA4 conta no resumo e derruba o "Aprovado".');
