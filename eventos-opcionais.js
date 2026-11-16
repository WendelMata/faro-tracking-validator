"use strict";

// FONTE ÚNICA das combinações marca+região que o Mapa de Tags marca como "N/A" — ou seja, o
// evento NÃO É ESPERADO naquela marca naquela região. Vem do cruzamento com a propriedade
// "Marcas SITE" do Notion.
//
// Estava embutida no server.js e só a área de saúde a consultava. O schema.json declara o
// evento para a marca sem saber da exceção por região — e por isso cobrava da Marca C coisas
// que a loja não tem: select_promotion na PDC, grid_size, share na PDP, e três eventos de
// vitrine na home (que não tem vitrine nenhuma). Isso gera lacunas falsas na avaliação.
//
// Mantida como arquivo próprio para que servidor e jornada leiam o MESMO dado: duplicar a
// lista garantiria divergência na primeira atualização do Mapa.

const EVENTOS_OPCIONAIS = new Set([
  'marca-d::view_item_list::Checkout',
  'marca-d::view_item_list::Mini-cart',
  'marca-d::select_promotion::PDC',
  'marca-b::add_to_wishlist::Home',
  'marca-b::add_to_wishlist::Busca',
  'marca-b::add_to_wishlist::PDC',
  'marca-b::add_coupon::Mini-cart',
  'marca-b::view_item_list::Mini-cart',
  'marca-b::share::PDP',
  'marca-b::view_promotion::PDC',
  'marca-b::add_to_wishlist::Checkout',
  'marca-b::select_promotion::Menu',
  'marca-b::view_item_list::Checkout',
  'marca-b::select_promotion::PDC',
  'marca-b::view_promotion::Menu',
  'marca-b::grid_size::PDC',
  'marca-b::add_to_cart::Mini-cart',
  'marca-b::add_to_cart::Busca',
  'marca-b::add_to_cart::Home',
  'marca-b::add_to_wishlist::Mini-cart',
  'marca-h::add_to_wishlist::Mini-cart',
  'marca-i::grid_size::PDC',
  'marca-c::add_to_wishlist::Home',
  'marca-c::view_item_list::Mini-cart',
  'marca-c::share::PDP',
  'marca-c::view_promotion::PDC',
  'marca-c::add_to_wishlist::Checkout',
  'marca-c::select_item::Home',
  'marca-c::view_item_list::Home',
  'marca-c::view_item_list::Checkout',
  'marca-c::refine_results::Busca',
  'marca-c::select_promotion::PDC',
  'marca-c::grid_size::PDC',
  'marca-c::add_to_cart::Mini-cart',
  'marca-c::add_to_cart::Home',
  'marca-j::add_to_wishlist::PDP',
  'marca-j::remove_from_cart::Mini-cart',
  'marca-j::add_to_wishlist::Busca',
  'marca-j::add_to_wishlist::PDC',
  'marca-j::add_coupon::Mini-cart',
  'marca-j::add_to_cart::Wishlist',
  'marca-j::view_cart::Mini-cart',
  'marca-j::select_item::Wishlist',
  'marca-j::select_item::Mini-cart',
  'marca-j::select_promotion::PDC',
  'marca-j::view_item_list::Wishlist',
  'marca-j::grid_size::PDC',
  'marca-j::search_zipcode::Mini-cart',
  'marca-j::add_to_cart::Mini-cart',
  'marca-j::add_to_wishlist::Mini-cart',
]);

// EXCLUSÕES QUE VALEM PARA TODAS AS MARCAS, não por combinação.
//
// `select_content` na Home não existe em home de marca nenhuma do grupo (determinação do
// usuário em 2026-10-25: "a área de saúde já deveria tratar isso assim"). O Mapa de Tags ainda
// declara o evento, então sem esta lista a validação cobra de todas as dez marcas um evento que
// nenhuma tem.
//
// Separado de EVENTOS_OPCIONAIS de propósito: aquele espelha o cruzamento "Marcas SITE" do
// Notion e deve continuar espelhando. Este é decisão de produto, e precisa ficar visível como
// tal, com a data e o motivo.
const OPCIONAIS_EM_TODA_MARCA = new Set([
  'select_content::Home',
  // select_promotion na PDC não é cobrado de marca nenhuma (determinação do usuário em
  // 2026-10-27). Já estava listado por marca em marca-d/marca-b/marca-c/marca-j; as
  // entradas de lá continuam porque EVENTOS_OPCIONAIS espelha o cruzamento "Marcas SITE" do
  // Notion e tem que continuar espelhando — apagar de lá apagaria o espelho, não a regra.
  'select_promotion::PDC',
]);

// REGIÃO QUE A MARCA NÃO TEM — exclusão por REGIÃO, não por evento.
//
// A marca-j não tem Wishlist hoje (usuário, 2026-10-27), então nenhum evento daquela região
// pode ser cobrado dela. Os três que o Mapa declara lá (add_to_cart, select_item,
// view_item_list) já estavam listados um a um em EVENTOS_OPCIONAIS, e funcionava — mas só
// enquanto a lista acompanhasse o Mapa. Bastaria o Mapa ganhar um quarto evento de Wishlist
// para a marca-j nascer com uma lacuna fantasma que ninguém pediu.
//
// Declarar a REGIÃO resolve de uma vez e deixa a intenção legível: a entrada diz "a marca-j não
// tem Wishlist", em vez de três linhas soltas que não explicam por quê. Quando a região existir,
// apaga-se UMA linha — era isso que o usuário quis dizer com "caso isso mude a gente ajusta".
//
// As entradas por evento em EVENTOS_OPCIONAIS continuam onde estão, porque aquela lista espelha
// o cruzamento "Marcas SITE" do Notion e deve continuar espelhando.
const REGIOES_INEXISTENTES = new Set([
  'marca-j::Wishlist',
]);

// EVENTO QUE A MARCA NÃO TEM — em região NENHUMA.
//
// Decorre do mesmo fato: sem Wishlist, não há como favoritar em lugar algum, então
// `add_to_wishlist` não pode ser cobrado da marca-j em região nenhuma (usuário, 2026-10-27).
// Não bastava a regra de região acima, porque o Mapa declara o evento também em PDC, PDP, Busca
// e Mini-cart — lugares que a marca-j TEM; o que não existe é o destino do favorito.
//
// Escopo: marca-j apenas. As outras nove têm wishlist e disparam o evento de verdade (a Maria
// Filó, por exemplo, tem add_to_wishlist em pdc, pdp e minicart na sessão de referência), então
// isentar todas apagaria cobrança legítima de nove marcas.
const EVENTOS_INEXISTENTES_POR_MARCA = new Set([
  'marca-j::add_to_wishlist',
]);

// EXCLUSÕES DO APP — lista própria, de propósito.
//
// O score do App (calcularScoreSessaoApp + mobile/coverage-schema.json) é isolado do Web e não
// consultava este módulo: honrava só EVENTOS_IGNORAR_SEMPRE_GLOBAL. Por isso o
// `select_promotion::PDC` que saiu da cobrança do Web em 2026-10-27 continuava sendo cobrado no
// App, inclusive da Marca F.
//
// Não dá para o App simplesmente reusar as listas de cima:
//   - EVENTOS_OPCIONAIS espelha o cruzamento "Marcas SITE" do Notion. É sobre o SITE. Aplicar no
//     App isentaria coisa que o app tem, com base numa exceção que é da web.
//   - OPCIONAIS_EM_TODA_MARCA traz `select_content::Home`, que no app dispara de verdade
//     (`select_content :: home` ×5 na sessão da Farm de 27/10). A regra é da web.
//
// Então o App ganha a sua: hoje só `select_promotion::PDC`, que vale para todas as marcas por
// simetria com a decisão do Web. Se for para valer só na Marca F, troca por
// 'marca-f::select_promotion::PDC' e ajusta o ehOpcional.
const OPCIONAIS_APP_EM_TODA_MARCA = new Set([
  'select_promotion::PDC',
]);

// REGIÃO QUE SÓ EXIGE ALGUNS EVENTOS — lista de PERMISSÃO, não de exclusão.
//
// A Home do app da marca-a não tem vitrine (usuário, 2026-10-27): lá só existem banners. Então
// view_item_list, select_item e add_to_wishlist não têm o que medir naquela tela, e os únicos
// eventos exigidos são os de promoção.
//
// Enunciado como permissão de propósito, porque foi assim que o fato foi dito — "só view e
// select promotion". Listar os três a excluir daria no mesmo HOJE e envelheceria mal: bastaria o
// Mapa declarar um quarto evento de vitrine na Home para a marca-a nascer com uma lacuna que
// ninguém pode fechar, já que a vitrine não existe.
//
// Em compensação, um evento NOVO e legítimo na Home desta marca entraria isento sem avisar. É o
// preço da permissão, e é o lado certo de errar aqui: lacuna que não se pode fechar é ruído toda
// semana, e evento novo na Home de um app sem vitrine é raro.
const SO_ESTES_NA_REGIAO_APP = new Map([
  ['marca-a::Home',    new Set(['view_promotion', 'select_promotion'])],
  // Marca C tem a mesma home sem vitrine (usuário, 2026-10-27). As duas chaves ficam
  // separadas e não viram uma regra "toda marca": Marca F, marca-b, Marca H, Marca I e
  // marca-j têm vitrine na home e os eventos de lá são cobrados com razão.
  ['marca-c::Home', new Set(['view_promotion', 'select_promotion'])],
]);

// EXCLUSÕES DO APP POR MARCA — um evento numa região, sem mexer no resto dela.
//
// `select_content` na Wishlist da marca-j não é exigido (usuário, 2026-10-27). Aqui NÃO cabia a
// regra de região nem a de permissão: a Wishlist da marca-j EXISTE no app, e add_to_cart,
// select_item e view_item_list disparam lá normalmente — só esse evento não se aplica.
//
// Vale notar o contraste com a lista do Web, onde `marca-j::Wishlist` está em
// REGIOES_INEXISTENTES: no site a marca-j não tem wishlist nenhuma, no app tem. É exatamente o
// motivo de as listas das duas plataformas serem separadas em vez de uma só.
const EVENTOS_OPCIONAIS_APP = new Set([
  'marca-j::select_content::Wishlist',
  'nv::select_content::Wishlist',
]);

const ehOpcionalApp = (marca, evento, regiao) => {
  if (EVENTOS_OPCIONAIS_APP.has(`${marca}::${evento}::${regiao}`)) return true;
  const permitidos = SO_ESTES_NA_REGIAO_APP.get(`${marca}::${regiao}`);
  if (permitidos && !permitidos.has(evento)) return true;
  return OPCIONAIS_APP_EM_TODA_MARCA.has(`${evento}::${regiao}`);
};

// O SITE NÃO TEM COMO DISPARAR — Web.
//
// Não é preferência nem decisão de escopo: a loja não oferece a ação. Na marca-a não existe
// botão de favoritar dentro do checkout, nem vitrine de produto lá, nem como adicionar ao
// carrinho direto do resultado de busca (usuário, 2026-10-27). Evento que não tem gesto que o
// produza não é lacuna — é checkpoint que nunca deveria existir para esta marca.
//
// Mesma natureza de REGIOES_INEXISTENTES (a marca-j sem wishlist) e de SO_ESTES_NA_REGIAO_APP
// (as homes sem vitrine), só que no recorte marca+evento+região.
//
// Separada de EVENTOS_OPCIONAIS de propósito: aquela espelha o cruzamento "Marcas SITE" do
// Notion e precisa continuar espelhando. Misturar as duas faria a próxima sincronização apagar
// isto achando que é dado defasado — ou faria alguém procurar no Notion uma regra que nunca
// esteve lá.
const NAO_EXISTE_NO_SITE = new Set([
  'marca-a::add_to_wishlist::Checkout',
  'marca-a::view_item_list::Checkout',
  'marca-a::add_to_cart::Busca',
  // marca-b, 2026-10-27: a PDC não tem botão de adicionar ao carrinho. Ela já tinha Home, Busca e
  // Mini-cart isentas em EVENTOS_OPCIONAIS pelo cruzamento do Notion; a PDC faltava, e nela só
  // dá para abrir o produto.
  'marca-b::add_to_cart::PDC',
  // A marca-j NÃO ENTRA NESTA LISTA — e o engano vale ficar registrado.
  //
  // Em 2026-10-27 isentei cinco combinações dela (view_promotion e select_promotion no Menu,
  // add_coupon e order_reviewed no Checkout, refine_results na PDC) lendo "falta no site mesmo"
  // como "a loja não tem a ação". O usuário corrigiu: ali falta IMPLEMENTAÇÃO. Toda loja tem
  // etapa de revisão de pedido, campo de cupom e filtro de categoria — o evento não sair nesses
  // lugares é defeito, e defeito tem que pesar na nota.
  //
  // É exatamente a linha que separa esta lista de uma lacuna legítima: gesto que NÃO EXISTE sai
  // do total; gesto que existe e não dispara FICA, doendo na nota até alguém corrigir. Diluir os
  // dois casos transforma o dash num número que não mede nada.
]);

// chave no formato usado pelos dois lados: marca::evento::Região
const ehOpcional = (marca, evento, regiao) =>
  NAO_EXISTE_NO_SITE.has(`${marca}::${evento}::${regiao}`) ||
  REGIOES_INEXISTENTES.has(`${marca}::${regiao}`) ||
  EVENTOS_INEXISTENTES_POR_MARCA.has(`${marca}::${evento}`) ||
  EVENTOS_OPCIONAIS.has(`${marca}::${evento}::${regiao}`) ||
  OPCIONAIS_EM_TODA_MARCA.has(`${evento}::${regiao}`);

module.exports = {
  OPCIONAIS_APP_EM_TODA_MARCA,
  EVENTOS_OPCIONAIS_APP,
  SO_ESTES_NA_REGIAO_APP,
  ehOpcionalApp,
  EVENTOS_OPCIONAIS,
  OPCIONAIS_EM_TODA_MARCA,
  REGIOES_INEXISTENTES,
  NAO_EXISTE_NO_SITE,
  EVENTOS_INEXISTENTES_POR_MARCA,
  ehOpcional,
};
