// validator.js v3
// Valida eventos do dataLayer contra schema.json
// Compara parâmetros entre eventos (consistência de item_id, item_name, etc.)
// Compara dataLayer vs GA4

const fs   = require('fs');
const path = require('path');

// Parâmetros marcados como (APP) no Mapa de Tags do Notion — nunca preenchidos
// no Web, então ausência deles não deve virar erro de schema no ambiente web.
const PARAMS_APP_ONLY = ['str_line_items', 'line_items', 'item_list_id', 'seller_id'];

// Parâmetros que existem no dataLayer mas o GTM nunca mapeia pra tag do GA4 — não é
// diferença de plataforma (isso é PARAMS_APP_ONLY), é diferença de "pra onde esse dado
// vai": o campo é real e obrigatório no DL, mas a tag do GA4 no GTM deliberadamente não
// inclui esses parâmetros (confirmado com print da configuração da tag pela equipe —
// add_to_cart, line_items não está entre os "Parâmetro de evento" mapeados). Checar
// esses campos contra o hit de GA4 é presumir, sem base, que tudo que está no DL foi
// disparado pro GA4 também — problema recorrente, reportado em 19/08/2026. Só afeta o
// lado GA4 da validação (ver ga4Check em validateEvent); o lado dataLayer continua
// exigindo normalmente, porque lá o campo é real.
const PARAMS_NAO_ENVIADOS_AO_GA4 = ['line_items', 'str_line_items'];

function loadSchema() {
  const p = path.join(__dirname, 'schema.json');
  if (!fs.existsSync(p)) return { events: [] };
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// Detecta hit de tag legada/duplicada (ex.: pixel antigo tipo Universal Analytics) —
// usa os campos genéricos "dimension1/2/3" dentro dos itens em vez dos campos de
// ecommerce de verdade. Mesmo detector usado nos motores de saúde do server.js.
function temDimensaoGenericaLegado(dlEvent) {
  const ev    = dlEvent.event ?? dlEvent;
  const eco   = ev.ecommerce ?? ev;
  const items = eco.items ?? ev.items ?? [];
  return items.some(it => it && (it.dimension1 !== undefined || it.dimension2 !== undefined || it.dimension3 !== undefined));
}

// Detecta evento nativo da plataforma (Vtex) disparando sem prefixo com o MESMO
// nome que a marca usa pro próprio evento "custom_X" — não é o mesmo disparo em
// dois formatos, são dois eventos independentes que coincidem de nome. Achado
// real: "purchase" nativo da Vtex no checkout, sem "ecommerce.brand" e com só um
// subconjunto mínimo de campos, enquanto o "custom_purchase" da marca sempre tem
// "brand" (documentado como parâmetro no schema do Notion) e o payload completo.
// Sem essa distinção, o "purchase" nativo "suprimia" o custom_ de verdade, e um
// hit de GA4 que pode nem ser da tag da marca aparecia como confirmação dela.
function pareceEventoNativoPlataforma(dlEvent) {
  const ev  = dlEvent.event ?? dlEvent;
  const eco = ev.ecommerce ?? ev;
  // Falsy, não só === undefined — achado real: "purchase" nativo da Vtex no marca-f
  // vem com brand: "" (string vazia via GA4/gtag, que sempre inclui a chave), não
  // undefined. Com o check estrito, esse hit nunca era reconhecido como nativo e o
  // "custom_purchase" de verdade (com item_ref/item_sku) nunca era usado no lugar.
  return !eco.brand && !ev.brand;
}

// Acha o hit de GA4 correspondente a um disparo do dataLayer, casando pelo
// timestamp mais próximo — não só pelo nome do evento. Só por nome não é
// suficiente quando o mesmo evento dispara várias vezes na sessão (ex.: view_item
// em 6 produtos diferentes): "pega o próximo disponível" pareava o disparo de um
// produto com o hit de outro produto qualquer, só por estarem na mesma posição
// relativa nos dois arrays — o que gerava uma avalanche de "ausente no GA4" falso.
// Hits reais do mesmo disparo chegam poucos ms depois do dataLayer (visto no caso
// real do pdp/pdc: 12ms de diferença); acima de LIMITE_MS não é o mesmo disparo,
// é só o mais próximo que sobrou.
const GA4_MATCH_LIMITE_MS = 30000;
// Diferença máxima (ms) pra considerar um "custom_" da lista fechada empatado com o
// nativo que ganharia por distância — acima disso não é ruído de rede, é outro disparo
// de verdade (ver construirMatchesGA4).
const TOLERANCIA_EMPATE_CUSTOM_MS = 500;
// "dataLayer::preview" é o painel de preview/debug do GTM, não um hit de rede real —
// pode disparar com dado incompleto (ex.: sem items[]) mesmo quando o hit real (mb::,
// gtag, sendBeacon, fetch, merged) existe na mesma sessão com os dados completos.
// Achado real: um add_to_cart pareou com um preview incompleto (item_id ausente) que
// disparou uns 600ms mais próximo, escondendo o hit real completo que disparou ~1s
// depois — "mais próximo no tempo" não deveria ganhar de "é rede de verdade".
function ehSourceDePreview(g) {
  return (g.event?._source ?? g._source) === 'dataLayer::preview';
}
// Decide, pra um evento do dataLayer, com qual nome ele deve ser casado (pra fins de
// schema E de GA4) — extraído pra fora de validateEvent pra poder ser usado também no
// pareamento global (ver construirMatchesGA4), sem duplicar a regra em dois lugares.
// custom_X só conta como "alias de um X que já existe separado" quando esse X:
// (a) não é uma tag legada (dimension1/2/3), (b) não é um evento nativo da
// plataforma disparando por conta própria (sem "brand" — ver
// pareceEventoNativoPlataforma), E (c) disparou perto no tempo — achado real: um
// "add_to_cart" de um produto A (não-legado) "liberava" o alias custom_ de um
// produto B totalmente diferente, só por ter o mesmo nome em algum lugar da sessão.
function resolverEventoParaMatch(dlEvent, allDlEvents) {
  const rawEventName = dlEvent.event?.event ?? dlEvent.event;
  if (isEventoTerceiro(rawEventName)) return null;
  if (rawEventName === 'user_info' || rawEventName === 'custom_user_info') return null;
  if (!isEventoCustom(rawEventName)) return { eventName: rawEventName, aliasDeCustom: null, ignoradoAlias: false };

  const baseName = normalizarNomeEvento(rawEventName);
  const dlTs = dlEvent.timestamp ?? 0;
  const baseJaExisteSeparado = allDlEvents.some(other => {
    if (other === dlEvent) return false;
    const otherName = other.event?.event ?? other.event;
    if (otherName !== baseName) return false;
    if (temDimensaoGenericaLegado(other)) return false;
    if (pareceEventoNativoPlataforma(other)) return false;
    return Math.abs((other.timestamp ?? 0) - dlTs) <= GA4_MATCH_LIMITE_MS;
  });
  // Lista fechada dos eventos em que o "custom_X" é o disparo canônico da marca, e não
  // um alias descartável do nativo: nesses, os dois lados são validados contra o schema,
  // em vez de o "custom_" ser suprimido quando o nativo existe por perto. O motivo é que
  // suprimir escondia defeito real — o "custom_" é quem carrega o payload completo no
  // checkout, e quando o nativo aparecia junto era ELE quem respondia pela validação,
  // levando o erro a ser carimbado no evento errado (ou a não aparecer).
  if (EVENTOS_CUSTOM_VALIDA_AMBOS.has(baseName) && custom_PrevaleceNestaRegiao(baseName, dlEvent)) {
    return { eventName: baseName, aliasDeCustom: baseName, ignoradoAlias: false };
  }
  return { eventName: baseName, aliasDeCustom: baseName, ignoradoAlias: baseJaExisteSeparado };
}

// add_to_cart e remove_from_cart só têm forma "custom_" dentro do checkout — fora dali o
// push canônico é o nativo. Medido no acervo: dos 81 "custom_add_to_cart" e 86
// "custom_remove_from_cart" capturados, 100% dos que declaram região dizem "checkout".
// Região ausente não bloqueia: a maioria desses pushes não declara região nenhuma, e
// exigir o campo faria a regra não valer justamente onde ela foi medida.
const EVENTOS_CUSTOM_SO_NO_CHECKOUT = new Set(['add_to_cart', 'remove_from_cart']);

// Os sete eventos cuja forma "custom_" é o disparo de verdade da marca (lista fechada,
// definida pelo Mapa de Tags — não inferir a partir do que aparece no acervo).
const EVENTOS_CUSTOM_VALIDA_AMBOS = new Set([
  'view_cart',
  'begin_checkout',
  'add_to_cart',          // só no checkout — ver EVENTOS_CUSTOM_SO_NO_CHECKOUT
  'remove_from_cart',     // idem
  'add_shipping_info',
  'add_payment_info',
  'purchase',
]);

function custom_PrevaleceNestaRegiao(baseName, dlEvent) {
  if (!EVENTOS_CUSTOM_SO_NO_CHECKOUT.has(baseName)) return true;
  const regiao = dlEvent.event?.region ?? dlEvent.event?.ecommerce?.region ?? null;
  if (!regiao) return true;
  return String(regiao).toLowerCase().includes('checkout');
}

// view_promotion/select_promotion podem disparar várias vezes na mesma sessão (um por
// banner/carrossel) muito perto no tempo uns dos outros — distância sozinha não dá pra
// distinguir QUAL banner é QUAL hit quando dois disparos e dois hits competem quase
// simultâneos. Esses dois eventos têm campos de identidade que aparecem com o MESMO
// nome nos dois lados (ecommerce.* no dataLayer, params.* achatado no GA4) — usa isso
// como critério mais forte que distância. Achado real (marca-b, home): um "view_promotion"
// com creative_name "Banner Full" pareou com um hit de creative_name "Banner Principal"
// (banners totalmente diferentes) só por estar mais perto no tempo.
const CAMPOS_IDENTIDADE_PROMOCAO = ['promotion_name', 'creative_slot', 'creative_name'];
const EVENTOS_COM_IDENTIDADE_PROMOCAO = new Set(['view_promotion', 'select_promotion']);

function extrairCampoDL(dl, campo) {
  const data  = dl.event ?? dl;
  const ecomm = data.ecommerce ?? {};
  return data[campo] ?? ecomm[campo] ?? null;
}
function extrairCampoGA4(g, campo) {
  const gData  = g.event ?? g;
  const params = gData.params ?? gData;
  return params[campo] ?? null;
}
// Quantos dos campos de identidade batem exatamente entre o disparo e o hit — só
// calculado pros eventos de promoção (nos demais eventos esses campos nem existem,
// então o score fica sempre 0 e não interfere na ordenação).
function contarCamposIdenticos(nome, dl, g) {
  if (!EVENTOS_COM_IDENTIDADE_PROMOCAO.has(nome)) return 0;
  let score = 0;
  for (const campo of CAMPOS_IDENTIDADE_PROMOCAO) {
    const a = extrairCampoDL(dl, campo);
    const b = extrairCampoGA4(g, campo);
    if (a != null && b != null && String(a) === String(b)) score++;
  }
  return score;
}

// Casa TODOS os disparos do dataLayer (de um mesmo nome efetivo) com os hits de GA4 de
// uma vez só, ordenando por distância (e preferindo fonte real sobre preview) antes de
// atribuir — não é mais "cada disparo pega o mais próximo disponível na hora em que é
// processado". Achado real: um "add_to_cart" legado, processado primeiro só por estar
// antes no array, roubava o hit de GA4 que na verdade pertencia ao custom_add_to_cart
// do mesmo produto (53ms de diferença, contra 1.6s do legado) — a ordem de varredura
// não é critério de qualidade de pareamento, distância é.
function construirMatchesGA4(dlEvents, ga4Index, resolverNome = resolverEventoParaMatch) {
  const porNome = new Map();
  for (const dl of dlEvents) {
    const resolved = resolverNome(dl, dlEvents);
    if (!resolved || resolved.ignoradoAlias) continue;
    // NÃO excluir tag legada/evento nativo da competição por hit de GA4 — tentado
    // e revertido (achado real: no caso do "custom_purchase" do marca-f, o
    // custom_ vai pro GA4 por um mecanismo próprio/oculto que a captura de rede
    // do Faro não enxerga; o hit de GA4 real e visível pareia mesmo é com o
    // "purchase" nativo da Vtex — mais perto no tempo é o critério certo aqui,
    // igual ao caso do add_to_cart legado que motivou essa função originalmente).
    // MAS quando o "custom_" empata (dentro de uma tolerância curta) com o nativo
    // mais próximo, o "custom_" tem prioridade — achado real (marca-a,
    // add_shipping_info): conferido direto no GTM, só existe trigger pro
    // "custom_add_shipping_info" (o nativo não está cabeado a nenhuma tag ali), e
    // os dois caíam a 275ms/325ms do hit real — diferença de 50ms, ruído de rede,
    // não motivo pra preferir o nativo. Isso não é prioridade incondicional: no
    // caso do marca-f (custom_purchase 2.7s longe do hit vs. purchase nativo a
    // 66ms) a diferença é grande demais pra ser empate — o nativo segue vencendo,
    // porque o hit do "custom_" ali é mesmo de um mecanismo oculto/tardio, não o
    // mesmo disparo do nativo. Ver TOLERANCIA_EMPATE_CUSTOM_MS abaixo.
    if (!porNome.has(resolved.eventName)) porNome.set(resolved.eventName, []);
    porNome.get(resolved.eventName).push({ dl, isCustomAlias: !!resolved.aliasDeCustom });
  }

  const resultado = new Map();
  for (const [nome, entradas] of porNome) {
    const candidatos = ga4Index[nome] ?? [];
    const pares = [];
    for (const { dl, isCustomAlias } of entradas) {
      const dlTs = dl.timestamp ?? 0;
      for (const g of candidatos) {
        const dist = Math.abs((g.timestamp ?? 0) - dlTs);
        if (dist > GA4_MATCH_LIMITE_MS) continue;
        const contentScore = contarCamposIdenticos(nome, dl, g);
        // Pros eventos de promoção, zero campo de identidade batendo não é "empate fraco",
        // é forte indício de que não é o mesmo disparo — nunca casa nesse caso, mesmo sem
        // concorrente melhor (senão um hit órfão de tag de teste/fantasma, sem nenhum push
        // real correspondente no dataLayer, "rouba" o disparo mais próximo disponível só
        // por estar dentro da janela de 30s — achado real, ver comentário acima da função).
        if (EVENTOS_COM_IDENTIDADE_PROMOCAO.has(nome) && contentScore === 0) continue;
        pares.push({ dl, g, dist, isCustomAlias, contentScore, preview: ehSourceDePreview(g) ? 1 : 0 });
      }
    }
    // Conteúdo idêntico (promotion_name/creative_slot/creative_name) vence distância —
    // só entra em jogo pros eventos de promoção, ver contarCamposIdenticos. Depois,
    // rede de verdade antes de preview; dentro do mesmo tipo, mais perto primeiro.
    pares.sort((a, b) => (b.contentScore - a.contentScore) || (a.preview - b.preview) || (a.dist - b.dist));
    // Empate custom_ vs nativo: se o "custom_" mais próximo cair a até
    // TOLERANCIA_EMPATE_CUSTOM_MS do nativo que ganharia (mesma qualidade de fonte),
    // promove o "custom_" pra frente — ver comentário acima.
    if (pares.length > 0 && !pares[0].isCustomAlias) {
      const melhor = pares[0];
      const idxCustomEmpate = pares.findIndex(p =>
        p.isCustomAlias && p.preview === melhor.preview && (p.dist - melhor.dist) <= TOLERANCIA_EMPATE_CUSTOM_MS
      );
      if (idxCustomEmpate > 0) {
        const [empatado] = pares.splice(idxCustomEmpate, 1);
        pares.unshift(empatado);
      }
    }
    const dlUsado = new Set(), g4Usado = new Set();
    for (const par of pares) {
      if (dlUsado.has(par.dl)) continue;
      const key = (par.g.event?.event_name ?? par.g.event_name) + '::' + par.g.timestamp;
      if (g4Usado.has(key)) continue;
      dlUsado.add(par.dl);
      g4Usado.add(key);
      resultado.set(par.dl, par.g);
    }
  }
  return resultado;
}

// user_info não tem entrada no schema.json — a estrutura é aninhada
// (user_info.customer.*, user_info.address.*) e varia de formato entre marcas (às
// vezes dentro de ecommerce.user_info, às vezes direto em ecommerce.*), então não
// cabe no modelo padrão de parâmetros de raiz/items[]. Checagem dedicada, regra
// confirmada com a equipe: o userId e o email têm que ser identificáveis onde quer
// que disparem — na prática cada marca usa um campo diferente pro mesmo dado (Carol
// Bassi manda customer.userId; marca-a e Marca E só mandam customer.id; Marca E ainda
// tem um userId solto dentro de address, sem relação com customer) — checa os
// lugares reais já observados nos dados, não um caminho fixo só. O resto do perfil
// (telefone, nome, nascimento, documento, gênero) é informativo e nunca conta como erro.
function validateUserInfo(dlEvent, rawEventName) {
  const ev       = dlEvent.event ?? dlEvent;
  const userInfo = ev.user_info ?? ev.ecommerce?.user_info ?? ev.ecommerce ?? {};
  const customer = userInfo.customer ?? {};
  const address  = userInfo.address ?? {};

  const userId = customer.userId || customer.id || address.userId || address.id;
  const email  = customer.email  || address.email;

  const result = {
    event: rawEventName, regiao: null, status: 'passou',
    errors: [], warnings: [], passed: [], raw: dlEvent.event,
  };
  if (!userId) { result.errors.push('userId: ausente'); result.status = 'falhou'; }
  else            result.passed.push('userId: ok');
  if (!email)  { result.errors.push('email: ausente');  result.status = 'falhou'; }
  else            result.passed.push('email: ok');
  return result;
}

// Checa parâmetros de raiz + items[] contra o schema, olhando pra uma única fonte de
// dados por vez — usada tanto pro dataLayer quanto pro GA4 (ver validateEvent), pra não
// duplicar a mesma regra duas vezes. getRoot(nome) resolve um parâmetro de raiz (com o
// fallback pro primeiro item, igual já era feito); items é a lista de produtos já
// extraída da fonte em questão (ecommerce.items no DL, params.items no GA4).
// ignorarParams (só usado no lado GA4, ver PARAMS_NAO_ENVIADOS_AO_GA4) exclui o campo
// da checagem por completo — nem erro, nem aviso, nem "ok" — porque cobrar presença
// desses campos ali é presumir sem base que tudo do DL também foi pro GA4.
// ─── FORMATO DO VALOR ────────────────────────────────────────────────────────
// Até aqui o validador só perguntava "o campo veio?". Um valor presente mas malformado
// passava como "ok" — achado real: um select_item da marca-a com item_variant "Vermelho "
// e item_variant2 " 42" saía limpo. Dois níveis de severidade, decididos com o usuário:
//
// AVISO (não reprova) — espaço sobrando. Não reprova porque é generalizado: 544
// ocorrências em 56 sessões do acervo, concentradas em item_variant (136),
// item_variant2 (128), item_category2 (115) e item_list_name (102). Transformar isso em
// erro viraria o acervo inteiro de ✅ pra ❌ de uma vez. Mas também não é cosmético: no
// GA4 " 42" e "42" viram DOIS valores distintos de dimensão e fragmentam o relatório —
// por isso precisa ficar contado e visível, não só destacado na tela pro analista.
// Repare que o check de consistência não cobre este caso: ele só acusa se o valor VARIAR
// entre eventos, então um espaço presente em todo o funil passa despercebido.
//
// ERRO (reprova) — item_sku/item_id não-numérico. Medido no acervo: item_id nunca viola
// (0 ocorrências), e as 118 violações de item_sku em 23 sessões são todas a descrição da
// variante no lugar do código ("Lily Azul Onda - PP", "Cinza Oliva - P"). Isso quebra o
// join com a base de produtos — não é questão de leitura, é dado inutilizável.
const CAMPOS_NUMERICOS = new Set(['item_sku', 'item_id']);

function checarFormatoValor(rotulo, nome, value) {
  const r = { erros: [], avisos: [] };
  if (typeof value !== 'string') return r;  // número já chega tipado, nada a conferir
  const limpo = value.trim();
  if (limpo === '') return r;               // string só de espaço é ausência, tratada acima

  if (limpo !== value) {
    r.avisos.push(`${rotulo}: espaço sobrando no valor (${JSON.stringify(value)})`);
  }
  if (CAMPOS_NUMERICOS.has(nome) && !/^\d+$/.test(limpo)) {
    r.erros.push(`${rotulo}: deveria ser numérico, veio ${JSON.stringify(value)}`);
  }
  return r;
}

function checarParametrosSchema(schema, eventName, { getRoot, items: itemsBruto, ignorarParams = [] }) {
  const result = { status: 'passou', errors: [], warnings: [], passed: [] };
  // "items" pode chegar serializado como JSON-string (captura ADB faz isso, é o mesmo
  // motivo de parseShippings existir). Uma string tem .length, então passava pela guarda
  // de array vazio e estourava no forEach logo abaixo — derrubando validateAll inteiro e
  // fazendo a sessão ser salva sem validação. Normalizar aqui cobre os dois lados (DL e
  // GA4), porque ambos chamam esta função.
  const items = parseItems(itemsBruto);
  const EVENTOS_SEM_ITEMS = new Set(['view_promotion', 'select_promotion']);
  const ignorarItems = EVENTOS_SEM_ITEMS.has(eventName);

  const rootParams = schema.parameters.filter(p => !p.path && !ignorarParams.includes(p.name));
  const itemParams = schema.parameters.filter(p => p.path?.startsWith('items[].') && !ignorarParams.includes(p.path.replace('items[].', '')));

  for (const param of rootParams) {
    if (param.name === 'items') {
      if (ignorarItems) continue; // view_promotion/select_promotion: skip items
      if (!items.length) {
        result.errors.push(`items: array ausente ou vazio`);
        result.status = 'falhou';
      } else {
        result.passed.push(`items: ${items.length} produto(s)`);
      }
      continue;
    }

    const value = getRoot(param.name);
    if (value === undefined || value === null || value === '') {
      if (param.required) {
        if (PARAMS_APP_ONLY.includes(param.name)) {
          result.warnings.push(`${param.name}: ausente (parâmetro de app — não considerado erro no web)`);
        } else {
          result.errors.push(`${param.name}: ausente`);
          result.status = 'falhou';
        }
      }
      continue;
    }

    const typeErr = checkType(param.name, value, param.type);
    if (typeErr) {
      result.errors.push(typeErr);
      result.status = 'falhou';
    } else {
      const fmt = checarFormatoValor(param.name, param.name, value);
      result.errors.push(...fmt.erros);
      result.warnings.push(...fmt.avisos);
      if (fmt.erros.length) result.status = 'falhou';
      else result.passed.push(`${param.name}: ok`);
    }
  }

  if (!ignorarItems && itemParams.length > 0 && items.length > 0) {
    items.forEach((item, idx) => {
      for (const param of itemParams) {
        const fieldName = param.path.replace('items[].', '');
        // coupon é documentado como campo do item no schema, mas na prática a marca
        // manda no nível do pedido (ecommerce.coupon) — pedido explícito: aceitar de
        // onde vier, já que é o mesmo cupom pro pedido inteiro num carrinho de 1 item.
        const value     = item?.[fieldName] ?? (fieldName === 'coupon' ? getRoot(fieldName) : undefined);

        if (value === undefined || value === null || value === '') {
          if (param.required) {
            if (PARAMS_APP_ONLY.includes(fieldName)) {
              result.warnings.push(`items[${idx}].${fieldName}: ausente (parâmetro de app — não considerado erro no web)`);
            } else {
              result.errors.push(`items[${idx}].${fieldName}: ausente`);
              result.status = 'falhou';
            }
          }
          continue;
        }

        const rotulo  = `items[${idx}].${fieldName}`;
        const typeErr = checkType(rotulo, value, param.type);
        if (typeErr) {
          result.errors.push(typeErr);
          result.status = 'falhou';
        } else {
          result.passed.push(`${rotulo}: ok`);
        }
      }
    });
  }

  // Formato do valor é varrido sobre TODOS os campos de texto do item, não só os que o
  // schema declara. Motivo concreto: "select_item @ Checkout" não declara item_sku nem
  // item_variant2, então o " 42" que a marca-a manda em item_variant2 não era checado por
  // nada — nem presença, nem formato. Se a marca mandou o campo, o valor tem que estar
  // bem formado, o Mapa pedindo ou não: um espaço sobrando fragmenta a dimensão no GA4
  // independentemente de o campo ser obrigatório. Varrer tudo também cobre promotion_id
  // e sku, que estão fora do schema.
  if (!ignorarItems && items.length > 0) {
    items.forEach((item, idx) => {
      if (!item || typeof item !== 'object') return;
      for (const [campo, valor] of Object.entries(item)) {
        const fmt = checarFormatoValor(`items[${idx}].${campo}`, campo, valor);
        result.errors.push(...fmt.erros);
        result.warnings.push(...fmt.avisos);
        if (fmt.erros.length) result.status = 'falhou';
      }
    });
  }

  return result;
}

// ─── VALIDAÇÃO DE UM EVENTO CONTRA O SCHEMA ──────────────────────────────────
// Cada disparo do dataLayer é validado duas vezes, contra a mesma regra de schema, mas
// em duas fontes diferentes — resultado fica em result (dataLayer) e result.ga4 (o hit
// de GA4 desse MESMO disparo, achado pelo horário mais próximo). Os dois veredictos são
// independentes um do outro: o dataLayer pode estar "certo" e o GA4 "errado" (ou
// vice-versa) — nenhum lado empresta valor pro outro. Pedido da equipe: o Faro não
// pode presumir que o que o dataLayer prometeu é o que o GA4 recebeu; os dois lados da
// tela (dataLayer e GA4 capturado) devem ser conferidos de forma independente, mas
// sempre falando do mesmo disparo — mesmo quando o mesmo evento se repete várias vezes
// na sessão.
function validateEvent(dlEvent, schemaEvents, allDlEvents = [], ga4MatchMap = new Map()) {
  const rawEventName = dlEvent.event?.event ?? dlEvent.event;
  const region        = dlEvent.event?.region ?? dlEvent.event?.ecommerce?.region ?? null;

  if (isEventoTerceiro(rawEventName)) {
    return { event: rawEventName, regiao: null, status: 'ignorado',
      errors: [], warnings: ['Evento de terceiro — ignorado na validação'], passed: [], raw: dlEvent.event, ga4: null };
  }

  if (rawEventName === 'user_info' || rawEventName === 'custom_user_info') {
    const r = validateUserInfo(dlEvent, rawEventName);
    r.ga4 = { status: 'ausente', errors: [], warnings: ['user_info não é enviado como hit de GA4 — só existe no dataLayer'], passed: [], raw: null };
    return r;
  }

  // custom_X é o nome que o GTM usa no DataLayer antes de disparar o hit real do
  // GA4 como "X" — mas em telas como mini-cart/checkout o "X" nunca chega a existir
  // como push próprio no DL, só o "custom_X" existe. Nesse caso valida "custom_X"
  // contra o schema de "X" (senão os params desses eventos nunca são checados).
  // Se "X" também existir separado no DL (de verdade, perto no tempo, não-legado),
  // mantém o comportamento antigo (ignora o alias, quem valida é o "X" de verdade) —
  // regra centralizada em resolverEventoParaMatch (reaproveitada no pareamento
  // global de GA4 também, ver construirMatchesGA4).
  let eventName = rawEventName;
  let aliasDeCustom = null;
  if (isEventoCustom(rawEventName)) {
    const resolved = resolverEventoParaMatch(dlEvent, allDlEvents);
    if (resolved.ignoradoAlias) {
      return { event: rawEventName, regiao: null, status: 'ignorado',
        errors: [], warnings: ['Alias DL de "' + resolved.eventName + '" — validado via GA4'], passed: [], raw: dlEvent.event, ga4: null };
    }
    eventName = resolved.eventName;
    aliasDeCustom = resolved.eventName;
  }

  // Busca schema: tenta match exato com região, depois sem região
  let schema = schemaEvents.find(s =>
    s.event === eventName && s.regiao && region &&
    region.toLowerCase().includes(s.regiao.toLowerCase())
  );
  if (!schema) schema = schemaEvents.find(s => s.event === eventName && !s.regiao);
  if (!schema) schema = schemaEvents.find(s => s.event === eventName);

  const result = {
    event:    rawEventName,
    regiao:   schema?.regiao ?? region ?? null,
    status:   'passou',
    errors:   [],
    warnings: aliasDeCustom ? [`Validado via alias "custom_" de "${aliasDeCustom}"`] : [],
    passed:   [],
    raw:      dlEvent.event,
  };

  if (!schema) {
    result.warnings.push(`Evento "${eventName}" não encontrado no schema do Notion`);
    result.status = 'desconhecido';
    result.ga4 = null;
    return result;
  }

  // ── Lado dataLayer — o que o site prometeu mandar ──────────────────────────
  const data  = dlEvent.event ?? {};
  const ecomm = data.ecommerce ?? {};
  const items = ecomm.items ?? data.items ?? [];
  const item0 = items[0] ?? {};

  const dlCheck = checarParametrosSchema(schema, eventName, {
    getRoot: (nome) => data[nome] ?? ecomm[nome] ?? item0[nome],
    items,
  });
  result.status = dlCheck.status === 'falhou' ? 'falhou' : result.status;
  result.errors.push(...dlCheck.errors);
  result.warnings.push(...dlCheck.warnings);
  result.passed.push(...dlCheck.passed);

  // shippings[] (search_zipcode) só existe no dataLayer — não faz parte do check
  // espelhado no GA4 ainda, incerto se esse array chega lá de forma confiável.
  const shippingParams = schema.parameters.filter(p => p.path?.startsWith('shippings[].'));
  const shippings       = parseShippings(data.shippings ?? ecomm.shippings);
  if (shippingParams.length > 0 && shippings.length > 0) {
    shippings.forEach((ship, idx) => {
      const isPickup = typeof ship.shipping_tier === 'string' && ship.shipping_tier.toLowerCase().startsWith('retire na loja');
      for (const param of shippingParams) {
        const fieldName = param.path.replace('shippings[].', '');
        if (fieldName === 'line_items' && isPickup) continue;
        const value = ship[fieldName];

        if (value === undefined || value === null || value === '') {
          if (param.required) {
            result.errors.push(`shippings[${idx}].${fieldName}: ausente`);
            result.status = 'falhou';
          }
          continue;
        }

        const typeErr = checkType(`shippings[${idx}].${fieldName}`, value, param.type);
        if (typeErr) {
          result.errors.push(typeErr);
          result.status = 'falhou';
        } else {
          result.passed.push(`shippings[${idx}].${fieldName}: ok`);
        }
      }
    });
  }

  // ── Lado GA4 — o que o Google recebeu de verdade, MESMO disparo (achado pelo
  // horário mais próximo) — veredito totalmente independente do lado dataLayer.
  const ga4Match = ga4MatchMap.get(dlEvent) ?? null;
  if (!ga4Match) {
    result.ga4 = { status: 'ausente', errors: [], warnings: ['Evento disparou no dataLayer mas não chegou ao GA4'], passed: [], raw: null };
  } else {
    const ga4Data   = ga4Match.event ?? ga4Match;
    const ga4Params = ga4Data.params ?? ga4Data;
    const ga4Items  = ga4Params.items ?? ga4Data.items ?? [];
    const ga4Item0  = ga4Items[0] ?? {};
    const ga4Check  = checarParametrosSchema(schema, eventName, {
      getRoot: (nome) => ga4Params[nome] ?? ga4Item0[nome],
      items: ga4Items,
      ignorarParams: PARAMS_NAO_ENVIADOS_AO_GA4,
    });
    // raw guarda o hit inteiro (com timestamp/url no nível de fora), mesmo formato
    // de sessionDetail.ga4Events[i] — não só a parte interna .event — pra exportação
    // de PDF conseguir reaproveitar sem reformatar.
    result.ga4 = { ...ga4Check, raw: ga4Match };
  }

  return result;
}

// Mesma tolerância do parseShippings, para o array de items: devolve sempre um array,
// qualquer que seja a forma de chegada (array, JSON-string, ou lixo).
function parseItems(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

// "shippings" pode chegar serializado como JSON-string (ex.: captura ADB) — mesma
// tolerância que o Faro App já aplica em mobile/payload-mapper.js.
function parseShippings(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return [];
}

function checkType(name, value, expected) {
  if (expected === 'string'  && typeof value !== 'string')  return `${name}: esperado string, recebido ${typeof value} (${JSON.stringify(value)})`;
  if (expected === 'number'  && typeof value !== 'number')  return `${name}: esperado number, recebido ${typeof value} (${JSON.stringify(value)})`;
  if (expected === 'boolean' && typeof value !== 'boolean') return `${name}: esperado boolean, recebido ${typeof value} (${JSON.stringify(value)})`;
  if (expected === 'array'   && !Array.isArray(value))      return `${name}: esperado array, recebido ${typeof value}`;
  return null;
}

// ─── CONSISTÊNCIA ENTRE EVENTOS ──────────────────────────────────────────────
// Campos que devem ser iguais entre eventos que referenciam o mesmo produto
// 'index' saiu em 2026-10-15: é a posição do item na lista, então varia legitimamente
// entre a vitrine e o carrinho. Medido no acervo: variava em 14,6% dos grupos (1.006
// casos) contra ~2% dos demais campos — afogava as inconsistências reais em ruído.
// 'price' e 'discount' ficam: a variação deles não é só promoção. O acervo tem
// "178 vs 17800" no mesmo produto, que é erro de unidade (centavos contra reais).
const CAMPOS_CONSISTENCIA = [
  'item_id', 'item_name', 'item_brand', 'item_variant',
  'item_category', 'item_category2', 'item_ref', 'item_sku', 'price', 'discount',
];

// Sinais que identificam o mesmo produto entre eventos. Usados para agrupar, não para
// comparar: dois itens que compartilhem QUALQUER um destes valores são o mesmo produto.
// item_name sozinho é fraco demais (cores diferentes repetem o nome), por isso entra
// composto com a variante.
function sinaisDeIdentidade(item) {
  const sinais = [];
  for (const campo of ['item_id', 'item_sku', 'item_ref']) {
    const v = item?.[campo];
    if (v !== undefined && v !== null && String(v) !== '') sinais.push(campo + '=' + String(v));
  }
  const nome = item?.item_name;
  if (nome !== undefined && nome !== null && String(nome) !== '') {
    sinais.push('nome=' + String(nome) + '|' + String(item?.item_variant ?? ''));
  }
  return sinais;
}

function verificarConsistencia(dlEvents) {
  // Antes, o produto era identificado por `item_id ?? item_sku ?? item_name` — ou seja,
  // pelo próprio campo que precisa ser vigiado. Se o item_id variasse entre eventos, as
  // duas ocorrências viravam entradas distintas no mapa e a inconsistência nunca era
  // detectada: o check era cego exatamente no identificador. Medido no acervo: 1.354
  // ocorrências de identificador variando para o mesmo produto, invisíveis.
  //
  // Agora os itens são agrupados por equivalência: duas ocorrências que compartilhem
  // QUALQUER sinal de identidade são o mesmo produto. Assim o item_id que mudou é
  // flagrado pelo item_ref que não mudou, e vice-versa.
  const pai = new Map();                                   // união-busca sobre os sinais
  const acha = (x) => { while (pai.get(x) !== x) { pai.set(x, pai.get(pai.get(x))); x = pai.get(x); } return x; };
  const une  = (a, b) => { if (!pai.has(a)) pai.set(a, a); if (!pai.has(b)) pai.set(b, b);
                           const ra = acha(a), rb = acha(b); if (ra !== rb) pai.set(ra, rb); };

  const ocorrencias = [];                                  // { sinais, item, evento }
  for (const dlEvent of dlEvents) {
    const data      = dlEvent.event ?? dlEvent;
    const eventName = data.event;
    const items     = parseItems(data.ecommerce?.items ?? data.items);
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const sinais = sinaisDeIdentidade(item);
      if (sinais.length === 0) continue;
      sinais.forEach(s => { if (!pai.has(s)) pai.set(s, s); });
      for (let i = 1; i < sinais.length; i++) une(sinais[0], sinais[i]);
      ocorrencias.push({ sinais, item, evento: eventName });
    }
  }

  // Agrupa as ocorrências pelo representante do conjunto e compara campo a campo.
  const grupos = new Map();
  for (const oc of ocorrencias) {
    const chave = acha(oc.sinais[0]);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(oc);
  }

  const inconsistencias = [];
  for (const ocs of grupos.values()) {
    for (const campo of CAMPOS_CONSISTENCIA) {
      let primeiro = null;
      for (const oc of ocs) {
        const valor = oc.item[campo];
        if (valor === undefined) continue;
        if (primeiro === null) { primeiro = { valor, evento: oc.evento }; continue; }
        if (String(primeiro.valor) === String(valor)) continue;
        const ref = ocs.find(o => o.item.item_id !== undefined) ?? ocs[0];
        inconsistencias.push({
          item_id:       String(ref.item.item_id ?? ref.item.item_sku ?? ref.item.item_name ?? ''),
          item_name:     ref.item.item_name ?? String(ref.item.item_id ?? ''),
          campo,
          evento_origem: primeiro.evento,
          valor_origem:  String(primeiro.valor),
          evento_atual:  oc.evento,
          valor_atual:   String(valor),
        });
        primeiro = { valor, evento: oc.evento };           // segue rastreando a partir do mais recente
      }
    }
  }

  return inconsistencias;
}

// Eventos do dataLayer que são internos/GTM e não geram hit GA4 — ignorar na comparação
const EVENTOS_SEM_GA4 = new Set([
  'gtm.historyChange', 'gtm.historyChange-v2', 'gtm.dom', 'gtm.load',
  'gtm.js', 'gtm.click', 'gtm.scrollDepth', 'gtm.elementVisibility',
  'gtm.formSubmit', 'gtm.pageError', 'gtm.timer', 'gtm.linkClick',
  'view_category', 'trackOptanonEvent', 'OneTrustLoaded', 'OptanonLoaded',
  'OneTrustGroupsUpdated', 'virtual_pageview', 'deco',
]);

function isEventoTerceiro(nome) {
  if (!nome) return false;
  // Um push de dataLayer sem a chave `event` faz o chamador passar o objeto inteiro aqui,
  // e o startsWith abaixo estourava TypeError — derrubando validateAll inteiro e fazendo a
  // sessão ser salva sem validação nenhuma.
  if (typeof nome !== 'string') return false;
  return (
    nome.startsWith('oppuz:') ||
    nome.startsWith('szb_')   ||
    nome.startsWith('szb-')   ||
    (nome.includes(':') && !nome.startsWith('custom_'))
  );
}

function isEventoCustom(nome) {
  return typeof nome === 'string' && nome.startsWith('custom_');
}

function normalizarNomeEvento(nome) {
  if (isEventoCustom(nome)) return nome.replace('custom_', '');
  return nome;
}

// ─── COMPARAÇÃO DATALAYER vs GA4 ─────────────────────────────────────────────
// Índice de hits de GA4 por event_name — usado tanto aqui quanto na validação de
// parâmetro (validateAll/validateEvent), pra achar o hit real correspondente a um
// disparo do dataLayer.
function construirGA4Index(ga4Events) {
  const ga4Index = {};
  ga4Events.forEach(g => {
    const name = g.event?.event_name ?? g.event_name;
    if (!name) return;
    if (!ga4Index[name]) ga4Index[name] = [];
    ga4Index[name].push(g);
  });
  return ga4Index;
}

function compararDLvsGA4(dlEvents, ga4Events, eventMap = {}) {
  const comparacao = [];
  const schema     = loadSchema();

  const ga4Index = construirGA4Index(ga4Events);

  // ── Comparação view_promotion ↔ select_promotion ───────────────────────────
  const viewPromotions   = dlEvents.filter(e => (e.event?.event ?? e.event) === 'view_promotion');
  const selectPromotions = dlEvents.filter(e => (e.event?.event ?? e.event) === 'select_promotion');

  for (const sel of selectPromotions) {
    const selData  = sel.event ?? sel;
    const selEcomm = selData.ecommerce ?? {};
    const selName  = selEcomm.promotion_name ?? selEcomm.creative_slot ?? null;
    const viewPar  = viewPromotions.find(v => {
      const vEcomm = (v.event ?? v).ecommerce ?? {};
      return selName && (vEcomm.promotion_name === selName || vEcomm.creative_slot === selEcomm.creative_slot);
    });
    if (!viewPar) continue;
    const viewEcomm = (viewPar.event ?? viewPar).ecommerce ?? {};
    const divergencias = [];
    ['promotion_name','creative_slot','creative_name','region','currency'].forEach(campo => {
      const vv = viewEcomm[campo]; const sv = selEcomm[campo];
      if (vv === undefined && sv === undefined) return;
      if (vv === undefined) divergencias.push(campo + ': ausente no view_promotion, select="' + sv + '"');
      else if (sv === undefined) divergencias.push(campo + ': view="' + vv + '", ausente no select_promotion');
      else if (String(vv) !== String(sv)) divergencias.push(campo + ': view="' + vv + '" ≠ select="' + sv + '"');
    });
    comparacao.push({
      status: divergencias.length === 0 ? 'ok' : 'divergencias',
      dlEvent: 'select_promotion', ga4Event: 'select_promotion',
      dlPar: 'view_promotion', promocao: selName ?? '(sem promotion_name)', divergencias,
    });
  }

  // ── Comparação padrão DL vs GA4 ───────────────────────────────────────────
  // Resolve custom_X e aplica eventMap (config por marca) igual o código original
  // fazia, mas reaproveitando a regra de dedup nova (perto no tempo + não-legado) e
  // o pareamento global por distância — mesma correção de fundo aplicada em
  // validateAll (ver construirMatchesGA4): "pega o próximo disponível, processando
  // em ordem" pareava o disparo errado quando dois nomes competiam pelo mesmo hit.
  const resolverComEventMap = (dl, all) => {
    const r = resolverEventoParaMatch(dl, all);
    if (!r || r.aliasDeCustom) return r; // custom_ já resolvido — eventMap nunca se aplicou a ele
    return { ...r, eventName: eventMap[r.eventName] ?? r.eventName };
  };
  const matchesComparacao = construirMatchesGA4(dlEvents, ga4Index, resolverComEventMap);

  for (const dlEvent of dlEvents) {
    const dlName = dlEvent.event?.event ?? dlEvent.event;
    if (EVENTOS_SEM_GA4.has(dlName)) continue;
    if (isEventoTerceiro(dlName)) continue;

    const resolved = resolverComEventMap(dlEvent, dlEvents);
    if (!resolved || resolved.ignoradoAlias) continue;
    const ga4Name = resolved.eventName;
    const ga4Match = matchesComparacao.get(dlEvent) ?? null;

    if (!ga4Match) {
      const noSchema = schema.events.some(s => s.event === ga4Name);
      comparacao.push({
        status:       'nao_chegou_ga4',
        dlEvent:      dlName,
        ga4Event:     null,
        noSchema:     !noSchema,
        divergencias: ['"' + dlName + '" disparou no dataLayer mas não foi capturado no GA4'],
        nota:         'Pode ser limitação do PerformanceObserver (hit anterior à captura)',
      });
      continue;
    }

    const divergencias = [];
    const avisos = [];
    const ga4Parsed    = ga4Match.event ?? ga4Match;
    const dlData       = dlEvent.event ?? dlEvent;
    const dlEcomm      = dlData.ecommerce ?? {};
    const ga4Params    = ga4Parsed.params ?? ga4Parsed;

    // ── Comparação de parâmetros via schema ───────────────────────────────────
    // Para cada parâmetro do schema, verifica se está no DL e se chegou no GA4
    const schemaEv = schema.events.find(s => s.event === ga4Name);
    if (schemaEv) {
      const rootParams = schemaEv.parameters.filter(p => !p.path);
      for (const param of rootParams) {
        const pName = param.name;
        if (pName === 'items') continue; // itens verificados abaixo
        const dlVal  = dlData[pName]   ?? dlEcomm[pName];
        const ga4Val = ga4Params[pName] ?? ga4Parsed.ecommerce?.[pName];

        if (dlVal === undefined || dlVal === null || dlVal === '') {
          if (param.required) {
            if (PARAMS_APP_ONLY.includes(pName)) {
              avisos.push(pName + ': ausente no dataLayer (parâmetro de app — não considerado erro)');
            } else {
              divergencias.push(pName + ': ausente no dataLayer');
            }
          }
        } else if (ga4Val === undefined || ga4Val === null || ga4Val === '') {
          if (PARAMS_APP_ONLY.includes(pName)) {
            avisos.push(pName + ': presente no DL mas não chegou no GA4 (parâmetro de app — não considerado erro)');
          } else {
            divergencias.push(pName + ': presente no DL mas não chegou no GA4');
          }
        } else if (String(dlVal) !== String(ga4Val)) {
          // Só reporta divergência de valor se não for timestamp/id automático
          if (!['event_id','timestamp','fbp','ttp','send_to'].includes(pName)) {
            divergencias.push(pName + ': DL="' + String(dlVal).slice(0,40) + '" ≠ GA4="' + String(ga4Val).slice(0,40) + '"');
          }
        }
      }
    }

    // ── Comparação de items[] ─────────────────────────────────────────────────
    const dlItems  = dlEcomm.items ?? dlData.items ?? [];
    const ga4Items = ga4Params.items ?? ga4Parsed.items ?? [];
    // A lista era fixa e omitia justamente os campos mais auditados — item_url, image_url,
    // item_ref, item_sku, item_shipping_tier, coupon, item_list_name — todos declarados
    // como items[].* obrigatórios no schema. Um item_url presente em todo o DL e ausente
    // em todo o hit do GA4 não produzia divergência nenhuma nesta tela. A fonte de verdade
    // é o próprio schema, que o laço de rootParams logo acima já usa.
    const CAMPOS_ITEM = schemaEv
      ? [...new Set(schemaEv.parameters.filter(p => p.path?.startsWith('items[].'))
                                       .map(p => p.path.replace('items[].', '')))]
      : ['item_id','item_name','item_brand','price','discount','quantity','item_variant','item_category','item_category2','index'];

    // O guard antigo (`if (ga4Items.length > 0)`) suprimia exatamente o pior caso: hit sem
    // NENHUM item enquanto o dataLayer trazia produtos saía sem divergência alguma. Vai um
    // achado só para o evento, em vez de um por item, para informar sem inundar.
    if (dlItems.length > 0 && ga4Items.length === 0) {
      divergencias.push('items: DL enviou ' + dlItems.length + ' item(ns) e o GA4 não recebeu nenhum');
    }

    dlItems.forEach((dlItem, idx) => {
      const ga4Item = ga4Items[idx];
      if (!ga4Item) { if (ga4Items.length > 0) divergencias.push('item[' + idx + ']: presente no DL mas ausente no GA4'); return; }
      CAMPOS_ITEM.forEach(campo => {
        const dv = dlItem[campo]; const gv = ga4Item[campo];
        if (dv === undefined && gv === undefined) return;
        if (dv === undefined) divergencias.push('item[' + idx + '].' + campo + ': ausente no DL, GA4="' + gv + '"');
        else if (gv === undefined) divergencias.push('item[' + idx + '].' + campo + ': DL="' + dv + '", ausente no GA4');
        else if (String(dv) !== String(gv)) divergencias.push('item[' + idx + '].' + campo + ': DL="' + dv + '" ≠ GA4="' + gv + '"');
      });
    });

    comparacao.push({
      status:      divergencias.length === 0 ? 'ok' : 'divergencias',
      dlEvent:     dlName,
      ga4Event:    ga4Name,
      divergencias,
      avisos,
    });
  }

  return comparacao;
}

// ─── FUNÇÃO PRINCIPAL: valida todos os eventos ────────────────────────────────
function validateAll(dlEvents, ga4Events = []) {
  const schema      = loadSchema();
  const ga4Index    = construirGA4Index(ga4Events);
  const ga4MatchMap = construirMatchesGA4(dlEvents, ga4Index);
  const eventos     = dlEvents.map(ev => validateEvent(ev, schema.events, dlEvents, ga4MatchMap));

  const total    = eventos.length;
  const passed   = eventos.filter(e => e.status === 'passou').length;
  const failed   = eventos.filter(e => e.status === 'falhou').length;
  const unknown  = eventos.filter(e => e.status === 'desconhecido').length;
  const ignored  = eventos.filter(e => e.status === 'ignorado').length;

  // O resumo contava só o lado dataLayer, então uma sessão em que o hit chegou ao GA4
  // sem nenhum parâmetro saía com failed = 0 e o relatório carimbava "✅ Aprovado"
  // (server.js). O status por evento continua sendo só do dataLayer, de propósito — os
  // dois lados são independentes (ver comentário em validateEvent) — mas o resumo passa
  // a expor o veredito do GA4 para quem decide aprovação.
  //
  // 'falhou' e 'ausente' ficam separados porque significam coisas diferentes: 'falhou' é
  // o hit que chegou com parâmetro errado ou faltando, defeito real; 'ausente' é o hit que
  // não foi encontrado, que historicamente é falso-negativo de captura da extensão (janela
  // cega do início da página, hit que sai antes da navegação). Só 'falhou' derruba a
  // aprovação; 'ausente' fica visível sem reprovar.
  const ga4Failed  = eventos.filter(e => e.ga4?.status === 'falhou').length;
  const ga4Ausente = eventos.filter(e => e.ga4?.status === 'ausente').length;

  return {
    summary: { total, passed, failed, unknown, ignored, erros: failed, ga4Failed, ga4Ausente },
    eventos,
  };
}

// ─── PRINT PARA PLAYWRIGHT ───────────────────────────────────────────────────
function printReport(dlEvents, ga4Events = []) {
  const schema      = loadSchema();
  const ga4Index    = construirGA4Index(ga4Events);
  const ga4MatchMap = construirMatchesGA4(dlEvents, ga4Index);
  const eventos     = dlEvents.map(ev => validateEvent(ev, schema.events, dlEvents, ga4MatchMap));

  eventos.forEach((ev, i) => {
    const icon = ev.status === 'passou' ? '✅' : ev.status === 'falhou' ? '❌' : '❓';
    const reg  = ev.regiao ? ` (${ev.regiao})` : '';
    console.log(`[${i + 1}] ${icon} ${ev.event}${reg}`);
    ev.errors.forEach(e   => console.log(`  ❌ ${e}`));
    ev.warnings.forEach(w => console.log(`  ⚠️ ${w}`));
    ev.passed.forEach(p   => console.log(`  ✅ ${p}`));
  });

  const inc = verificarConsistencia(dlEvents);
  if (inc.length > 0) {
    console.log('\n===== INCONSISTÊNCIAS ENTRE EVENTOS =====');
    inc.forEach(i => {
      console.log(`Produto: "${i.item_name}" (item_id: "${i.item_id}")`);
      console.log(`  Campo: "${i.campo}"`);
      console.log(`  ${i.evento_origem}: "${i.valor_origem}"`);
      console.log(`  ${i.evento_atual}: "${i.valor_atual}"`);
    });
  }
}


// ─── DETECTA DISPAROS DUPLICADOS ─────────────────────────────────────────────
// Flageia quando o mesmo evento dispara 2x com os mesmos itens em < 2s
const EVENTOS_DUPLICATA = [
  'add_to_cart', 'remove_from_cart', 'add_to_wishlist',
  'select_item', 'view_item', 'begin_checkout', 'purchase',
];
const DUPLICATA_THRESHOLD_MS = 2000;

function detectarDuplicatas(dlEvents) {
  const duplicatas = [];
  const porEvento  = {};

  for (const dlEvent of dlEvents) {
    const data      = dlEvent.event ?? dlEvent;
    const eventName = data.event ?? data.event_name;
    if (!EVENTOS_DUPLICATA.includes(eventName)) continue;

    const ts    = dlEvent.timestamp ?? 0;
    const items = data.ecommerce?.items ?? data.items ?? [];
    const ids   = items.map(i => i.item_id ?? i.item_sku ?? '').filter(Boolean).sort().join(',');

    if (!porEvento[eventName]) porEvento[eventName] = [];
    porEvento[eventName].push({ ts, ids, items });
  }

  for (const [eventName, ocorrencias] of Object.entries(porEvento)) {
    ocorrencias.sort((a, b) => a.ts - b.ts);

    for (let i = 0; i < ocorrencias.length - 1; i++) {
      const atual   = ocorrencias[i];
      const proxima = ocorrencias[i + 1];
      const diffMs  = proxima.ts - atual.ts;

      if (diffMs <= DUPLICATA_THRESHOLD_MS && atual.ids && atual.ids === proxima.ids) {
        const item = atual.items?.[0];
        duplicatas.push({
          evento:       eventName,
          item_id:      item?.item_id   ?? atual.ids,
          item_name:    item?.item_name ?? eventName,
          timestamp1:   atual.ts,
          timestamp2:   proxima.ts,
          diferenca_ms: diffMs,
        });
        i++;
      }
    }
  }

  return duplicatas;
}

module.exports = { validateAll, validateEvent, verificarConsistencia, detectarDuplicatas, compararDLvsGA4, printReport };