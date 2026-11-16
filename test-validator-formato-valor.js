// Prova que valor presente mas malformado deixou de passar como "ok", nos dois níveis de
// severidade combinados com o usuário:
//   espaço sobrando          -> AVISO  (visível e contado, não reprova)
//   item_sku/item_id não-num -> ERRO   (reprova: quebra o join com a base de produtos)
// Caso que originou isto: select_item da marca-a no checkout com item_variant "Vermelho "
// e item_variant2 " 42" saindo limpo.
'use strict';
const assert = require('node:assert/strict');
const { validateAll } = require('./validator');

const base = {
  item_id: '92815', item_sku: '393215', item_ref: '52.10.5739_0400',
  item_name: 'Frente Unica', item_brand: 'marca-a', item_variant: 'Vermelho',
  item_variant2: '42', price: 2498, quantity: 1,
  item_url: 'https://x/p', image_url: 'https://x/i.jpg',
};
const validar = (sobrescreve) => validateAll([{
  event: { event: 'select_item', ecommerce: { brand: 'marca-a', region: 'checkout', items: [{ ...base, ...sobrescreve }] } },
  timestamp: 1000,
}], []).eventos[0];

const avisosEspaco = (e) => e.warnings.filter(w => /espaço sobrando/.test(w));
const errosNumero  = (e) => e.errors.filter(x => /deveria ser numérico/.test(x));

// 1) valor limpo não inventa achado
const limpo = validar({});
console.log('1) valor limpo ->', avisosEspaco(limpo).length === 0 && errosNumero(limpo).length === 0 ? 'nenhum achado (correto)' : 'FALSO POSITIVO');
assert.equal(avisosEspaco(limpo).length, 0, 'valor limpo não pode gerar aviso de espaço');
assert.equal(errosNumero(limpo).length, 0, 'valor limpo não pode gerar erro de formato');

// 2) espaço sobrando vira AVISO, nunca erro
console.log('');
console.log('2) espaço sobrando -> aviso, não erro:');
for (const [campo, valor] of [['item_variant', 'Vermelho '], ['item_variant2', ' 42'], ['item_category2', ' Mochila']]) {
  const e = validar({ [campo]: valor });
  const av = avisosEspaco(e);
  console.log('     ', campo.padEnd(16), av.length ? 'DETECTADO' : 'passou batido');
  assert.equal(av.length, 1, campo + ' com espaço deveria gerar exatamente 1 aviso');
  assert.ok(av[0].includes(JSON.stringify(valor)), 'o aviso precisa mostrar o valor cru, com o espaço visível');
  assert.equal(e.errors.filter(x => x.includes(campo)).length, 0, 'espaço sobrando não pode virar erro');
}

// 3) item_variant2 NÃO é declarado no schema de select_item — e mesmo assim é conferido.
// É o motivo de a varredura de formato não se limitar aos params do schema.
const naoDeclarado = validar({ item_variant2: ' 42' });
console.log('');
console.log('3) campo fora do schema do evento ->', avisosEspaco(naoDeclarado).length ? 'conferido mesmo assim (correto)' : 'IGNORADO');
assert.ok(avisosEspaco(naoDeclarado).some(w => w.includes('item_variant2')), 'campo não declarado também precisa ser conferido');

// 4) item_sku com a descrição da variante no lugar do código vira ERRO
console.log('');
console.log('4) item_sku/item_id não-numérico -> erro:');
for (const [campo, valor] of [['item_sku', 'Lily Azul Onda - PP'], ['item_id', 'abc-123']]) {
  const e = validar({ [campo]: valor });
  const er = errosNumero(e);
  console.log('     ', campo.padEnd(16), er.length ? 'DETECTADO -> ' + e.status : 'passou batido');
  assert.equal(er.length, 1, campo + ' não-numérico deveria gerar erro');
  assert.equal(e.status, 'falhou', campo + ' não-numérico tem que reprovar o evento');
}

// 5) numérico com espaço: as duas regras incidem, cada uma na sua severidade
const ambos = validar({ item_sku: ' 393215 ' });
console.log('');
console.log('5) item_sku " 393215 " -> aviso de espaço:', avisosEspaco(ambos).length, '| erro de número:', errosNumero(ambos).length);
assert.equal(avisosEspaco(ambos).length, 1, 'o espaço precisa ser avisado');
assert.equal(errosNumero(ambos).length, 0, 'depois de aparado o valor é numérico — não pode virar erro');

// 6) número de verdade não é tratado como texto
const numerico = validar({ price: 2498, quantity: 1 });
console.log('6) campos numéricos nativos ->', avisosEspaco(numerico).length === 0 ? 'intactos (correto)' : 'RUÍDO');
assert.equal(avisosEspaco(numerico).length, 0, 'valor numérico não passa pela regra de texto');

console.log('');
console.log('OK — valor malformado deixou de sair como "ok".');
