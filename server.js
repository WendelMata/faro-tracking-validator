const express = require('express');

// ── SSE — Live feed de sessões mobile ─────────────────────────────────────────
const liveConnections = new Map(); // sessionId -> Set<res>
const liveBuffer      = new Map(); // sessionId -> payload[] — replay ao reconectar
const LIVE_BUFFER_MAX = 500;

function broadcastLive(sessionId, payload) {
  if (!liveBuffer.has(sessionId)) liveBuffer.set(sessionId, []);
  const buf = liveBuffer.get(sessionId);
  buf.push(payload);
  if (buf.length > LIVE_BUFFER_MAX) buf.shift();
  const conns = liveConnections.get(sessionId);
  if (!conns || conns.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of conns) { try { res.write(data); } catch (_) {} }
}

// Carregamento defensivo do Faro App: se a pasta mobile/ tiver qualquer
// problema, o resto do servidor (Faro Web) continua funcionando normalmente —
// só os endpoints /mobile e /api/mobile/* ficam desativados.
let startSession, pushEvent, finalizeSession, getActiveSessions, getSession, updateScreenContext;
let normalizeMobileSession, normalizeFirebaseHit, normalizeDataLayerPush, isFirebaseHit, isDataLayerPush, isPartnerEvent, buildDlLikeFromGa4Events;
try {
  ({ startSession, pushEvent, finalizeSession, getActiveSessions, getSession, updateScreenContext } = require('./mobile/session-manager'));
  ({ normalizeMobileSession, normalizeFirebaseHit, normalizeDataLayerPush, isFirebaseHit, isDataLayerPush, isPartnerEvent, buildDlLikeFromGa4Events } = require('./mobile/payload-mapper'));
  console.log('[mobile] módulos carregados — endpoints /api/mobile/* ativos');
} catch (e) {
  console.warn('[mobile] pasta mobile/ não encontrada ou com erro — endpoints /api/mobile/* desativados:', e.message);
  startSession = pushEvent = finalizeSession = getSession = updateScreenContext = () => null;
  getActiveSessions = () => [];
  normalizeMobileSession = normalizeFirebaseHit = normalizeDataLayerPush = () => null;
  isFirebaseHit = isDataLayerPush = isPartnerEvent = () => false;
  buildDlLikeFromGa4Events = () => [];
}

// ── Store de logs de execução de fluxos (em memória) ──────────────────────
const flowLogsStore = new Map();
function flowLog(key, msg) {
  if (!flowLogsStore.has(key)) flowLogsStore.set(key, { logs: [], timestamp: Date.now() });
  const entry = flowLogsStore.get(key);
  entry.logs.push(msg);
  entry.timestamp = Date.now();
  console.log(msg);
  if (flowLogsStore.size > 20) {
    const oldest = [...flowLogsStore.keys()][0];
    flowLogsStore.delete(oldest);
  }
}
const cors    = require('cors');
// SEGURANÇA (pentest 11/2026, achado 5.1 — RCE): nunca usar exec() com string montada a partir
// de entrada do usuário. exec() passa a linha inteira para /bin/sh, então `marca` = "x;whoami"
// virava comando. execFile() recebe os argumentos em array e não invoca shell.
const { execFile, spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');

// CLI do Playwright chamada direto pelo node (sem npx/shell), igual em Linux e Windows.
function playwrightCli() {
  try { return path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js'); }
  catch { return path.join(__dirname, 'node_modules', '@playwright', 'test', 'cli.js'); }
}

// Identificadores que viram caminho de arquivo ou argumento de processo (marca, sessionId,
// flowId). Só letras, números, _ . - ; sem ".." para não sair do diretório (path traversal).
// Todos os IDs existentes em sessions/ e flows/ já seguem esse formato.
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/;
function isSafeId(v) { return typeof v === 'string' && SAFE_ID.test(v) && !v.includes('..'); }

async function commitToGitHub(filePath, content, message) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token || !repo) return null;

  const baseUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'User-Agent':    'tracking-tests',
    'Content-Type':  'application/json',
  };

  // Verifica se arquivo já existe para pegar o SHA
  let sha = null;
  try {
    const getResp = await fetch(baseUrl, { headers });
    if (getResp.ok) {
      const data = await getResp.json();
      sha = data.sha;
    }
  } catch {}

  // Faz o commit
  const putResp = await fetch(baseUrl, {
    method:  'PUT',
    headers,
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      ...(sha && { sha }),
    }),
  });

  return putResp.json();
}

// ── Constantes globais de validação ──────────────────────────────────────────
// Parâmetros exclusivos do app — ausência em sessões WEB não é erro
const PARAMS_WEB_ONLY_GLOBAL = new Set([
  'str_line_items', 'line_items', 'seller_id',
  'item_list_id', 'seller_cod_name', 'item_list_name', 'item_shipping_tier'
]);
// Parâmetros que nunca contam como erro, em nenhuma marca — não é diferença de app/web,
// é um parâmetro que na prática não é confiável/consistente o suficiente pra cobrar de
// ninguém. item_category4 (4º nível de categoria) já foi reportado como falso "ausente"
// repetidas vezes em marcas diferentes — deixou de fazer sentido tratar caso a caso por
// marca. Pedido de 19/08/2026 (generaliza o que antes só valia pra marca-d).
// ordering/category (refine_results): usuário pode refinar por só um filtro de cada vez,
// então "ausente" na SESSÃO inteira não deveria pesar no score de saúde — mas o schema
// continua com required:true (não usa PARAMS_IGNORAR_SEMPRE_GLOBAL pra isso), porque
// validator.js (Sessões de Extensão) usa o mesmo required:false pra pular a checagem por
// disparo individual, inclusive a comparação DL×GA4 — e isso escondeu um gap real (GTM não
// mandava "ordering" pro GA4 mesmo com valor no DL). Ignorar só aqui, na saúde, resolve sem
// esconder o problema da equipe. Hoje só existem em refine_results (ver schema.json).
const PARAMS_IGNORAR_SEMPRE_GLOBAL = new Set(['item_category4', 'ordering', 'category']);
// Eventos onde items[] não é exigido — ausência não é erro nem aviso
const EVENTOS_SEM_ITEMS_GLOBAL = new Set(['view_promotion', 'select_promotion']);
// Alguns eventos disparam com um valor de region que é sinônimo de outro, dependendo do
// fluxo do site — não é erro, é o mesmo conceito com nome diferente no payload.
// auth_action pode vir com region "login" ou "área logada" (os dois valores são igualmente
// válidos pro mesmo checkpoint). Chave e valor já normalizados (ver normalizarRegiao) —
// aplicado só na comparação de region, nunca no valor exibido. Pedido de 19/08/2026.
const REGION_ALIASES_POR_EVENTO_GLOBAL = {
  auth_action: { login: 'arealogada' },
};
function aplicarAliasRegiaoGlobal(nome, regionNorm) {
  return REGION_ALIASES_POR_EVENTO_GLOBAL[nome]?.[regionNorm] ?? regionNorm;
}
// Eventos onde, havendo múltiplos disparos genuínos (não duplicata de destino, ex.: Ads+
// Analytics do mesmo instante), só o disparo MAIS COMPLETO da sessão inteira conta pra
// validação — ao contrário do padrão (um disparo de referência por instante, com union de
// erros entre todos). begin_checkout pode disparar mais de uma vez numa sessão (ex.: usuário
// volta pro checkout), e um disparo incompleto anterior não deve contaminar o resultado se
// já existe um disparo completo depois. view_cart só "vale" quando o carrinho tem produtos
// dentro — abrir o carrinho vazio dispara o evento mas não é o disparo que importa pra
// validação, se já existe um disparo com itens na sessão. Pedido de 19/08/2026.
const EVENTOS_MELHOR_DISPARO_UNICO_GLOBAL = new Set(['begin_checkout', 'view_cart']);
// Eventos que nunca contam pro score de saúde, disparando ou não — nem como checkpoint
// ausente (penaliza) nem como correto (soma pontos). "error" só existe pra sinalizar falha,
// não é um checkpoint de jornada; "video_loop_start" é comportamental (depende do usuário
// esperar o vídeo rodar em loop), não faz sentido cobrar presença nem ausência. Pedido de
// 19/08/2026 — generaliza o tratamento que "error" já tinha só quando ausente.
const EVENTOS_IGNORAR_SEMPRE_GLOBAL = new Set(['error', 'video_loop_start']);
// Eventos que uma marca ainda não implementou numa região específica, mas pode vir a
// implementar — diferente de remover a marca de marcas_site (que tiraria a validação de
// vez), aqui a ausência só não conta como erro; se o evento disparar, valida normalmente
// como qualquer outro checkpoint. Marca D: view_item_list ainda não existe no
// Checkout nem no Mini-cart; select_promotion ainda não existe no PDC. Pedido de
// 19/08/2026.
// marca-b (NV): as combinações abaixo vêm marcadas "NV - N/A" na tabela "Marcas SITE" do
// mapa de tags (Notion, fonte de verdade) — o schema.json continua listando marca-b em
// marcas_site pra elas (não alteramos o schema, que o validator.js e outros endpoints
// também leem), só a saúde do Faro para de cobrar a ausência. video_loop_start/PDP não
// entra aqui porque já é ignorado globalmente (EVENTOS_IGNORAR_SEMPRE_GLOBAL). As 3 linhas
// de select_content (Home/Checkout/Wishlist) saíram daqui em 20/08/2026: select_content
// virou 1 checkpoint só por marca (ver EVENTOS_SEM_REGIAO_REAL_GLOBAL), então a exceção
// por região específica não faz mais sentido — o checkpoint único já reflete corretamente
// se o evento disparou em qualquer região aplicável a marca-b. Pedido de 20/08/2026.
// marca-h, marca-i, marca-c, 'marca-j': mesmo cruzamento do mapa de tags (Notion,
// tabela "Marcas SITE") feito pra marca-b, replicado pra essas 4 marcas em 20/08/2026 — cada
// combinação abaixo vem marcada "<Marca> - N/A" no mapa. Marca D ficou de fora desse
// cruzamento (a propriedade "Marcas SITE" do Notion não tem tag de exclusão pra ela — só
// existe "CB - N/A" em "Marcas APP", que é outra propriedade). select_content também não
// entra pra nenhuma marca, pelo mesmo motivo do marca-b (checkpoint único, sem exceção por
// região). marca-a, marca-f e marca-g não tiveram divergência nenhuma no cruzamento.
// A lista saiu daqui para eventos-opcionais.js para centralizar as isenções por marca/região
// e evitar divergência em atualizações do Mapa de Tags.
const {
  EVENTOS_OPCIONAIS: EVENTOS_OPCIONAIS_POR_MARCA_REGIAO_GLOBAL,
  ehOpcional: ehOpcionalGlobal,
  ehOpcionalApp,
} = require('./eventos-opcionais');


// Parâmetros que uma marca específica não usa por decisão de catálogo/negócio — nunca
// contam como erro pra essa marca, venha o parâmetro ou não, mesmo que o schema exija
// o parâmetro pras demais. Marca D não tem variação de produto (sem grade de
// cor/tamanho como item_variant) — confirmado pelo time em 19/08/2026.
// (item_category4 saiu daqui e virou regra global — ver PARAMS_IGNORAR_SEMPRE_GLOBAL.)
const PARAMS_IGNORAR_POR_MARCA_GLOBAL = {
  'marca-d': new Set(['item_variant']),
};
// Eventos que nunca exigem "region" real no payload Web — mesmo que o schema passe a
// declarar o parâmetro "region" numa linha futura. select_content é um evento genérico de
// clique/conteúdo que aparece organicamente em várias regiões (não é region-específico como
// search_zipcode/add_coupon) e por padrão nunca envia region no Web.
const EVENTOS_SEM_REGION_OBRIGATORIA_WEB = new Set(['select_content']);
// Eventos que empiricamente NUNCA mandam "region" real no payload, em nenhuma marca — 916
// disparos reais checados (888 select_content + 28 notify_me), zero exceções. Diferente de
// EVENTOS_SEM_REGION_OBRIGATORIA_WEB (que só isenta a ausência de virar erro de parâmetro),
// aqui o problema é estrutural: o schema documenta esses eventos em várias linhas de região
// (select_content em 8, notify_me em 2) e, sem dado real de região em NENHUM disparo, cada
// linha aceitava o mesmo disparo ambíguo como prova — "aprovando" todas de uma vez. Colapsa
// em 1 checkpoint só por marca. Investigado em 20/08/2026.
const EVENTOS_SEM_REGIAO_REAL_GLOBAL = new Set(['select_content', 'notify_me']);
// Um disparo sem "region" só deve valer como prova de QUALQUER região quando não existe
// nenhuma evidência real (de nenhum outro disparo do mesmo evento, na mesma sessão) — senão
// ele "vaza" pra região que nunca disparou de verdade, mesmo já existindo prova de qual é a
// região certa (ex.: 8 disparos dizem "Home", 2 não dizem nada — os 2 não devem contar como
// prova de Menu/PDC). Investigado em 20/08/2026.
// REGIÃO INFERIDA PELA URL — só para o checkout.
//
// O checkout da VTEX mora em `secure.<marca>`, outro documento, e algumas marcas disparam lá
// sem o campo `region`. Medido em 2026-10-27: na Marca H o `add_to_cart` dispara em
// `secure.marca-h.com.br/checkout` sem region nenhuma (e sem o prefixo custom_, que é um
// defeito à parte). O evento aparece em 5 regiões no schema, então a regra de região única não
// alcança, e o dash mostrava "ausente" com o disparo ali na sessão.
//
// RESTRITO AO CHECKOUT DE PROPÓSITO. Houve uma versão que deduzia todas as regiões pela rota,
// com PDC como resíduo. Ela funcionava — 49 checkpoints recuperados em vez de 29 — mas deixou
// 15 checkpoints VERDES com `region` comprovadamente errado no payload, e nenhum deles voltou
// como erro: a nota média foi de 81 para 91 enquanto os defeitos continuavam inteiros. A Farm
// Rio marcava 90 com a vitrine ainda mandando `region: "pdc"` na wishlist e na PDP. Revertida
// a pedido do usuário em 2026-10-27: tirar o evento do "ausente" não pode significar dar nota
// cheia a uma região que está errada.
//
// A URL do checkout continua valendo porque ali não há palpite: nenhum outro evento mora em
// `secure.*` nem em `/checkout`. Inferir PDC, PDP ou Busca exige conhecer a rota de cada uma
// das dez lojas — e foi exatamente o resíduo "PDC" que chamou /nossas-lojas de categoria.
//
// NÃO entra em algumDisparoComRegiaoGlobal: aquele decide se o evento informa região "de
// verdade", e contaminá-lo com inferência mudaria eventos que dependem do fallback.
function regiaoPelaUrlGlobal(dl) {
  const ev  = dl.event ?? dl;
  const bruta = String(dl.url ?? ev.url ?? ev.page_location ?? '');
  if (!bruta) return null;

  let host = '', caminho = bruta;
  try { const u = new URL(bruta); host = u.host; caminho = u.pathname + u.search; }
  catch (_) { caminho = bruta.replace(/^https?:\/\/[^/]+/, ''); }

  if (/^secure\./i.test(host) || /\/checkout(\b|[/?#])/i.test(caminho)) return 'checkout';
  return null;
}
function algumDisparoComRegiaoGlobal(dlEvents, nome, extrairRegiaoFn) {
  return dlEvents.some(dl => {
    const ev = dl.event ?? dl;
    const evNome = ev.event ?? ev.event_name ?? '';
    const evNomeNorm = evNome.startsWith('custom_') ? evNome.replace('custom_', '') : evNome;
    const nomeMatch = (evNome === nome) || (evNomeNorm === nome) || (`custom_${evNome}` === nome);
    return nomeMatch && !!extrairRegiaoFn(dl);
  });
}
// Mesma técnica de remoção de acento usada em normalizarRegiaoOverviewApp (App) — NFD +
// strip de combining marks — portada aqui pra fechar o gap de normalização de region no Web
// (sem isso, "Logística" x "logistica" não batiam na comparação de region).
const REGEX_MARCAS_COMBINACAO_GLOBAL = new RegExp('[' + String.fromCodePoint(0x300) + '-' + String.fromCodePoint(0x36f) + ']', 'g');
function removerAcentosGlobal(s) {
  return s.normalize('NFD').replace(REGEX_MARCAS_COMBINACAO_GLOBAL, '');
}
// Mesma lista + mesmas regras de região de "eventos principais" usadas em
// mobile/dashboard.html (APP_HEALTH_EVENTOS_PRINCIPAIS / appHealthIsPrincipal) e em
// dashboard/src/health/eventos-principais.js (Web) — mantidas em sincronia manualmente,
// usadas só pra restringir a cobertura de parâmetros principais no modo "Eventos
// principais" da área de saúde, em Web e App (compartilhada, mesma regra nos dois lados).
const EVENTOS_PRINCIPAIS_GLOBAL = ['session_start', 'view_item_list', 'select_item', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'];
function isEventoPrincipalGlobal(schemaEv) {
  if (!EVENTOS_PRINCIPAIS_GLOBAL.includes(schemaEv.event)) return false;
  const regiao = (schemaEv.regiao ?? '').toLowerCase();
  if (schemaEv.event === 'view_item_list') return regiao === 'pdc';
  if (schemaEv.event === 'select_item')    return regiao === 'pdc';
  if (schemaEv.event === 'add_to_cart')    return ['pdc', 'pdp'].includes(regiao);
  if (schemaEv.event === 'begin_checkout') return regiao === 'checkout';
  if (schemaEv.event === 'purchase')       return regiao === 'checkout';
  return true;
}
// Pros eventos principais (exceto user_info, que tem regra própria de userId/email),
// só esses 6 campos contam pra saúde — mesma lista curada do App
// (APP_HEALTH_PARAMS_PRINCIPAIS em mobile/dashboard.html). O resto do schema desse
// evento (currency, brand, discount, quantity, category, etc.) deixa de ser cobrado
// nos eventos principais — continua valendo normalmente nos demais eventos. Pedido de
// 19/08/2026.
const PARAMS_SAUDE_EVENTOS_PRINCIPAIS_GLOBAL = new Set(['item_name', 'item_id', 'item_sku', 'item_ref', 'price', 'value']);
// Denominador da cobertura: pros eventos principais, conta só os campos curados que
// esse evento específico realmente declara no schema (ex.: view_item não tem item_sku,
// então não entra no denominador dele) — não os 6 fixos, senão eventos que não usam
// todos os 6 ficariam artificialmente com teto de cobertura menor que 100%.
function contarParamsAplicaveisGlobal(schemaEv) {
  const params = schemaEv.parameters ?? [];
  if (!isEventoPrincipalGlobal(schemaEv)) return params.length || 1;
  const count = params.filter(p => {
    const arrayMatch = p.path && p.path.match(/^(\w+)\[\]\.(.+)$/);
    const fieldName = arrayMatch ? arrayMatch[2] : (p.path ? p.path.replace('items[].', '') : p.name);
    return PARAMS_SAUDE_EVENTOS_PRINCIPAIS_GLOBAL.has(fieldName);
  }).length;
  return count || 1;
}

const app = express();
app.disable('x-powered-by');

// CABEÇALHOS DE SEGURANÇA (pentest 11/2026, achado 5.3 — Clickjacking — e observações HSTS,
// CSP, nosniff). Sem dependência nova: são só cabeçalhos fixos.
// A CSP aqui é a parte que dá para aplicar sem quebrar nada: bloqueia enquadramento
// (frame-ancestors), <base> e <object> injetados, e envio de formulário para fora. Ainda não
// restringe script-src porque o dashboard /mobile usa muitos onclick inline — apertar isso
// exige primeiro tirar os handlers inline do HTML.
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

// CORS (pentest 11/2026, achado 5.4). Antes era cors() = Access-Control-Allow-Origin: * para
// tudo. Quem usa a API de fato:
//   - dashboards Web e /mobile: mesma origem do servidor, não dependem de CORS;
//   - extensão Chrome (popup): tem host_permissions, mas a origem chrome-extension:// fica
//     liberada por garantia;
//   - faro-agente, adb-capture, app: clientes Node/nativos, CORS não se aplica;
//   - dev local: localhost.
// Origens extras podem ser liberadas por CORS_ORIGINS (lista separada por vírgula).
const CORS_EXTRA = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // mesma origem / clientes sem navegador
    const ok = CORS_EXTRA.includes(origin)
      || /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
      || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    cb(null, ok);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
}));

// AUTENTICAÇÃO DA API (pentest 11/2026 — recomendada nos 4 achados). Só /api/* é protegido;
// os arquivos estáticos do dashboard continuam públicos (não têm dado).
//
// Um token POR PESSOA OU SISTEMA. FARO_API_TOKENS = "nome:sha256;outro:sha256" — o servidor
// guarda só o hash (gere com scripts/gerar-token.js). Revogar = remover a entrada. O nome
// aparece no log de auditoria. FARO_API_TOKEN (um token único e compartilhado) continua aceito
// por compatibilidade, com o nome "compartilhado".
// Entradas: cabeçalho `X-Faro-Token` (extensão, agente, scripts) ou cookie de sessão do login
// no navegador. Com FARO_TRUST_IAP=1 (serviço atrás do IAP) vale também o e-mail do IAP.
// Sem nenhum token configurado o servidor continua aberto, como antes — assim este código pode
// ir para produção antes da configuração. Em produção o servidor avisa no log.
const crypto = require('crypto');
const FARO_TRUST_IAP = process.env.FARO_TRUST_IAP === '1';
const sha256hex = x => crypto.createHash('sha256').update(String(x)).digest('hex');
const TOKENS = new Map(); // nome -> sha256 hex do token
for (const entrada of (process.env.FARO_API_TOKENS || '').split(';').map(x => x.trim()).filter(Boolean)) {
  const i = entrada.indexOf(':');
  const nome = entrada.slice(0, i), hash = entrada.slice(i + 1).toLowerCase();
  if (i > 0 && /^[A-Za-z0-9_.-]{1,40}$/.test(nome) && /^[0-9a-f]{64}$/.test(hash)) TOKENS.set(nome, hash);
  else console.warn('[SEGURANÇA] entrada inválida em FARO_API_TOKENS ignorada:', nome || '(vazia)');
}
if (process.env.FARO_API_TOKEN) TOKENS.set('compartilhado', sha256hex(process.env.FARO_API_TOKEN));
// LOGIN GOOGLE (navegador). Ativo só com GOOGLE_CLIENT_ID definido. Aceita apenas contas do
// domínio FARO_GOOGLE_DOMAIN (padrão somagrupo.com.br). O navegador obtém um ID token do Google
// (Google Identity Services) e o servidor VERIFICA a assinatura RS256 com as chaves públicas do
// Google, o público (aud = nosso client id), a validade, e-mail verificado e domínio (hd).
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_DOMAIN = (process.env.FARO_GOOGLE_DOMAIN || 'somagrupo.com.br').toLowerCase();
const SESSION_SECRET = process.env.FARO_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (GOOGLE_CLIENT_ID && !process.env.FARO_SESSION_SECRET) {
  console.warn('[SEGURANÇA] FARO_SESSION_SECRET não definido: as sessões Google caem a cada reinício.');
}
const AUTH_ON = TOKENS.size > 0 || !!GOOGLE_CLIENT_ID;
let googleJwks = { keys: [], em: 0 };
async function googleKey(kid) {
  const velho = Date.now() - googleJwks.em > 3600e3;
  if (velho || !googleJwks.keys.find(k => k.kid === kid)) {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (!r.ok) throw new Error('certs do Google indisponíveis');
    googleJwks = { keys: (await r.json()).keys || [], em: Date.now() };
  }
  const jwk = googleJwks.keys.find(k => k.kid === kid);
  return jwk ? crypto.createPublicKey({ key: jwk, format: 'jwk' }) : null;
}
// Devolve o e-mail (minúsculo) se o ID token for válido e do domínio permitido; senão lança erro.
async function verificarGoogle(idToken) {
  const p = String(idToken || '').split('.');
  if (p.length !== 3) throw new Error('token malformado');
  const b64 = x => Buffer.from(x, 'base64url');
  const header = JSON.parse(b64(p[0]).toString());
  if (header.alg !== 'RS256') throw new Error('algoritmo inválido');
  const key = await googleKey(header.kid);
  if (!key) throw new Error('chave desconhecida');
  if (!crypto.verify('RSA-SHA256', Buffer.from(p[0] + '.' + p[1]), key, b64(p[2]))) throw new Error('assinatura inválida');
  const c = JSON.parse(b64(p[1]).toString());
  if (c.aud !== GOOGLE_CLIENT_ID) throw new Error('público inválido');
  if (c.iss !== 'accounts.google.com' && c.iss !== 'https://accounts.google.com') throw new Error('emissor inválido');
  if (!(c.exp * 1000 > Date.now())) throw new Error('token expirado');
  const email = String(c.email || '').toLowerCase();
  if (c.email_verified !== true || !email.endsWith('@' + GOOGLE_DOMAIN) || String(c.hd || '').toLowerCase() !== GOOGLE_DOMAIN) {
    throw new Error('conta fora do domínio permitido');
  }
  return email;
}
if (!AUTH_ON && process.env.NODE_ENV === 'production') {
  console.warn('[SEGURANÇA] nenhum token configurado (FARO_API_TOKENS): a API está SEM autenticação.');
}
// Compara com todos (sem sair no primeiro acerto) e em tempo constante.
function userByToken(given) {
  if (typeof given !== 'string' || !given) return null;
  const h = Buffer.from(sha256hex(given), 'hex');
  let achado = null;
  for (const [nome, hx] of TOKENS) if (crypto.timingSafeEqual(h, Buffer.from(hx, 'hex'))) achado = nome;
  return achado;
}

// Sessão de navegador: o login troca o token por um cookie HttpOnly "nome.HMAC", em que o HMAC
// usa o hash daquele usuário como chave — remover o usuário invalida o cookie dele na hora.
// EventSource (SSE) e links de relatório/PDF em outra aba não enviam cabeçalho, mas enviam
// cookie. SameSite=Strict + CORS restrito cobrem CSRF.
app.set('trust proxy', 1); // Cloud Run: necessário para req.secure refletir o HTTPS
const COOKIE_NAME = 'faro_auth';
const COOKIE_MAX_AGE = 12 * 60 * 60; // 12 h
const cookieSig = (nome) => crypto.createHmac('sha256', TOKENS.get(nome)).update('faro-browser-session').digest('hex');
function userByCookie(req) {
  const m = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE_NAME + '='));
  if (!m) return null;
  const val = m.slice(COOKIE_NAME.length + 1), i = val.lastIndexOf('.');
  if (i < 1) return null;
  const nome = val.slice(0, i);
  if (!TOKENS.has(nome)) return null;
  const esperado = Buffer.from(cookieSig(nome)), dado = Buffer.from(val.slice(i + 1));
  return dado.length === esperado.length && crypto.timingSafeEqual(dado, esperado) ? nome : null;
}
// Sessão Google: cookie "faro_sso" = base64url(email|expira).HMAC(FARO_SESSION_SECRET).
const SSO_COOKIE = 'faro_sso';
const ssoSig = x => crypto.createHmac('sha256', SESSION_SECRET).update('faro-sso:' + x).digest('hex');
function ssoCookieValue(email) {
  const body = Buffer.from(email + '|' + (Date.now() + COOKIE_MAX_AGE * 1000)).toString('base64url');
  return body + '.' + ssoSig(body);
}
function userBySso(req) {
  if (!GOOGLE_CLIENT_ID) return null;
  const m = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(SSO_COOKIE + '='));
  if (!m) return null;
  const val = m.slice(SSO_COOKIE.length + 1), i = val.lastIndexOf('.');
  if (i < 1) return null;
  const body = val.slice(0, i);
  const esperado = Buffer.from(ssoSig(body)), dado = Buffer.from(val.slice(i + 1));
  if (dado.length !== esperado.length || !crypto.timingSafeEqual(dado, esperado)) return null;
  const [email, exp] = Buffer.from(body, 'base64url').toString().split('|');
  return Number(exp) > Date.now() && email.endsWith('@' + GOOGLE_DOMAIN) ? email : null;
}
function setAuthCookie(req, res, value, maxAge) {
  res.append('Set-Cookie', `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`);
}
// Devolve o nome de quem está autenticado, ou null.
function authUser(req) {
  if (!AUTH_ON) return 'anonimo';
  return userByToken(req.get('x-faro-token'))
    || userByCookie(req)
    || userBySso(req)
    || (FARO_TRUST_IAP ? (req.get('x-goog-authenticated-user-email') || null) : null);
}

// Rotas de autenticação (fora do bloqueio). Limite contra força bruta: 10 tentativas por
// minuto por IP, em memória (instância única, ver deploy.sh).
const loginTentativas = new Map();
app.get('/api/auth/status', (req, res) => {
  const user = authUser(req);
  res.json({ required: AUTH_ON, authenticated: !!user, user: AUTH_ON ? user : null,
    googleClientId: GOOGLE_CLIENT_ID || null, googleDomain: GOOGLE_CLIENT_ID ? GOOGLE_DOMAIN : null });
});
app.post('/api/auth/login', express.json({ limit: '1kb' }), (req, res) => {
  if (!AUTH_ON) return res.json({ ok: true });
  const agora = Date.now();
  const t = (loginTentativas.get(req.ip) || []).filter(x => agora - x < 60000);
  if (t.length >= 10) return res.status(429).json({ error: 'muitas tentativas, aguarde um minuto' });
  t.push(agora); loginTentativas.set(req.ip, t);
  const nome = userByToken(req.body && req.body.token);
  if (!nome) return res.status(401).json({ error: 'token inválido' });
  setAuthCookie(req, res, `${nome}.${cookieSig(nome)}`, COOKIE_MAX_AGE);
  console.log(`[audit] login ${nome} ip=${req.ip}`);
  res.json({ ok: true, user: nome });
});
app.post('/api/auth/google', express.json({ limit: '8kb' }), async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(404).json({ error: 'login Google não configurado' });
  const agora = Date.now();
  const t = (loginTentativas.get(req.ip) || []).filter(x => agora - x < 60000);
  if (t.length >= 10) return res.status(429).json({ error: 'muitas tentativas, aguarde um minuto' });
  t.push(agora); loginTentativas.set(req.ip, t);
  try {
    const email = await verificarGoogle(req.body && req.body.credential);
    res.append('Set-Cookie', `${SSO_COOKIE}=${ssoCookieValue(email)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}${req.secure ? '; Secure' : ''}`);
    console.log(`[audit] login google ${email} ip=${req.ip}`);
    res.json({ ok: true, user: email });
  } catch (e) {
    console.warn(`[audit] login google negado ip=${req.ip}: ${e.message}`);
    res.status(401).json({ error: e.message === 'conta fora do domínio permitido' ? e.message : 'login Google inválido' });
  }
});
app.post('/api/auth/logout', (req, res) => {
  setAuthCookie(req, res, '', 0);
  res.append('Set-Cookie', `${SSO_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'autenticação necessária' });
  req.faroUser = user;
  // Auditoria: quem fez cada escrita. O ingest de eventos fica de fora (um POST por evento).
  if (AUTH_ON && req.method !== 'GET' && req.method !== 'HEAD' && !req.path.includes('/ingest/')) {
    console.log(`[audit] ${user} ${req.method} ${req.originalUrl.split('?')[0]}`);
  }
  next();
});

// VALIDAÇÃO DE PARÂMETROS DE ROTA (pentest 11/2026, achados 5.1 e 5.2). Vale para TODAS as
// rotas que usam :marca, :sessionId ou :flowId — inclusive as que montam caminho de arquivo.
for (const p of ['marca', 'sessionId', 'flowId']) {
  app.param(p, (req, res, next, val) => {
    if (!isSafeId(val)) return res.status(400).json({ error: `parâmetro ${p} inválido` });
    next();
  });
}
// LIMITE DO CORPO — e por que 10 MB não bastava.
//
// Jornada longa da marca-a não salvava. A causa não era o que o servidor GRAVA, e sim o que
// ele ACEITA: este middleware roda antes de qualquer rota, então rejeita a requisição com 413
// muito antes de o /api/save-session chegar a filtrar `page_view`. O filtro de lá (semPageView,
// criado em 2026-10-27) diminui o arquivo salvo e não ajuda em nada aqui.
//
// Medido numa sessão real de 178 eventos: o POST tem 7,39 MB, dos quais 7,15 MB são
// `page_view` — 3,57 MB em dlEvents e 3,58 MB em ga4Events. Tudo o que de fato importa soma
// 0,24 MB. Uma jornada com o dobro de navegação passa de 10 MB e o salvamento morre.
//
// A extensão é quem manda esse peso, e mexer nela já quebrou coisa que funcionava antes, então
// o servidor passa a aceitar. 50 MB cabe: a imagem instala o Chromium do Playwright, que não
// sobe nos 512Mi padrão, então o serviço tem no mínimo 2Gi. Fica em variável de ambiente para
// dar para apertar sem tocar no código, caso a memória da revisão mude.
app.use(express.json({ limit: process.env.JSON_LIMIT || '50mb' }));

// INVALIDAÇÃO DO CACHE DE LISTAGEM DO APP — por que aqui, e não em cada rota de escrita.
//
// O cache de `getMobileSessions` existe porque listar uma marca custa um download da API do
// GitHub POR SESSÃO: o contêiner não guarda `sessions/` em disco. Com TTL curto o cache quase
// nunca acertava e a cota de 5.000 chamadas/hora estourava — o GitHub passava a responder 403,
// o `catch` devolvia lista vazia em silêncio e o Cloud Run recusava com 429.
//
// Com TTL longo o risco vira o oposto: gravar uma sessão e ela não aparecer na lista. Daí a
// invalidação. Ela fica num middleware global, e não em cada rota que escreve, porque são seis
// hoje (save-session, stop, delete, rename, pasta, folders) e qualquer rota futura nasceria
// esquecida. Aqui, qualquer método que não seja leitura limpa o cache ao terminar bem.
//
// Limpa o mapa inteiro, não só a marca: escrita é rara (gravar, renomear, mover, excluir) e
// descobrir a marca exigiria ler `req.params` de rotas que ainda nem casaram. O custo de errar
// para mais é uma releitura; o de errar para menos é dado velho na tela.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.on('finish', () => { if (res.statusCode < 400) _mobileSessionsCache.clear(); });
  next();
});

// Corpo grande demais devolvia a página HTML de erro do Express, com stack trace — a extensão
// recebia isso no lugar de JSON e só conseguia dizer "não salvou". Responde em JSON para a
// mensagem chegar a quem está gravando a sessão.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({
      error: 'sessão grande demais para o limite atual do servidor',
      limite: process.env.JSON_LIMIT || '50mb',
      dica: 'quase todo o peso costuma ser page_view; se bateu neste limite, a jornada foi longa demais para uma sessão só',
    });
  }
  return next(err);
});

let recordingStatus = 'idle';

app.get('/api/version', (req, res) => {
  res.json({ version: '2026-07-22-HEALTH-FIX-v4' });
});

app.get('/api/marcas', async (req, res) => {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  // Se não tem GitHub configurado, lê do filesystem local
  if (!token || !repo) {
    const testsDir = './tests';
    const marcas = fs.readdirSync(testsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const fluxos = fs.readdirSync(path.join(testsDir, d.name))
          .filter(f => f.endsWith('.spec.js'))
          .map(f => ({ id: f.replace('.spec.js', ''), name: f.replace('.spec.js', '').replace(/-/g, ' '), file: f }));
        return { id: d.name, name: d.name, fluxos };
      });
    return res.json(marcas);
  }

  // Lê do GitHub
  try {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'tracking-tests',
    };

    const testsResp = await fetch(`https://api.github.com/repos/${repo}/contents/tests?ref=${branch}`, { headers });
    if (!testsResp.ok) throw new Error('Erro ao buscar pasta tests no GitHub');
    const testsDir = await testsResp.json();

    const marcas = await Promise.all(
      testsDir
        .filter(item => item.type === 'dir')
        .map(async dir => {
          const marcaResp = await fetch(`https://api.github.com/repos/${repo}/contents/tests/${dir.name}?ref=${branch}`, { headers });
          const files = marcaResp.ok ? await marcaResp.json() : [];
          const fluxos = files
            .filter(f => f.name.endsWith('.spec.js'))
            .map(f => ({
              id:   f.name.replace('.spec.js', ''),
              name: f.name.replace('.spec.js', '').replace(/-/g, ' '),
              file: f.name,
            }));
          return { id: dir.name, name: dir.name, fluxos };
        })
    );

    res.json(marcas);
  } catch (e) {
    console.error('Erro ao buscar marcas do GitHub:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/marcas', async (req, res) => {
  const { id, sgtm, eventMap } = req.body;
  if (!id || !sgtm) return res.status(400).json({ error: 'id e sgtm são obrigatórios' });

  const slug = id.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').trim();
  const dir  = path.join(__dirname, 'tests', slug);

  if (fs.existsSync(dir)) return res.status(400).json({ error: `Marca "${slug}" já existe` });

  fs.mkdirSync(dir, { recursive: true });
  const configContent = JSON.stringify({ sgtm, eventMap: eventMap ?? {} }, null, 2);
  fs.writeFileSync(path.join(dir, 'config.json'), configContent);

  // Commit no GitHub para persistir a marca
  try {
    await commitToGitHub(
      `tests/${slug}/config.json`,
      configContent,
      `marca: criar ${slug}`
    );
    // Cria também um .gitkeep para a pasta sessions aparecer no GitHub
    await commitToGitHub(
      `sessions/${slug}/.gitkeep`,
      '',
      `marca: criar sessões/${slug}`
    );
  } catch (e) {
    console.error('Erro ao commitar nova marca:', e.message);
    // Não falha — a marca foi criada localmente
  }

  res.json({ success: true, id: slug });
});

app.get('/api/marcas/:marca/config', (req, res) => {
  const { marca } = req.params;
  const configPath = path.join(__dirname, 'tests', marca, 'config.json');
  if (!fs.existsSync(configPath)) return res.json({ sgtm: '', eventMap: {} });
  try {
    res.json(JSON.parse(fs.readFileSync(configPath, 'utf-8')));
  } catch {
    res.json({ sgtm: '', eventMap: {} });
  }
});

app.put('/api/marcas/:marca', (req, res) => {
  const { marca } = req.params;
  const { sgtm, eventMap } = req.body;
  if (!sgtm) return res.status(400).json({ error: 'sgtm é obrigatório' });

  const dir = path.join(__dirname, 'tests', marca);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: `Marca "${marca}" não encontrada` });

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sgtm, eventMap: eventMap ?? {} }, null, 2));
  res.json({ success: true });
});

app.post('/api/run/:marca/:flowId', (req, res) => {
  const { marca, flowId } = req.params;
  const { testUrl, gtmPreviewUrl } = req.body;

  const env = {
    ...process.env,
    ...(testUrl       && { TEST_URL: testUrl }),
    ...(gtmPreviewUrl && { GTM_PREVIEW_URL: gtmPreviewUrl }),
  };

  const args = [playwrightCli(), 'test', `tests/${marca}/${flowId}.spec.js`, '--reporter=json'];

  execFile(process.execPath, args, { cwd: __dirname, env, maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
    try {
      const raw   = JSON.parse(stdout);
      const specs = raw.suites?.flatMap(s => s.specs ?? []) ?? [];

      const results = specs.map(spec => {
        const specConsoleText = extraiConsolePorSpec(spec);
        return {
          name:            spec.title,
          status:          spec.tests?.[0]?.results?.[0]?.status ?? 'failed',
          duration:        spec.tests?.[0]?.results?.[0]?.duration ?? 0,
          errorMessage:    spec.tests?.[0]?.results?.[0]?.errors?.[0]?.message ?? null,
          eventos:         parseConsoleReport(specConsoleText),
          inconsistencias: parseInconsistencias(specConsoleText),
          ga4Events:       extraiGA4(specConsoleText),
          comparacao:      extraiComparacao(specConsoleText),
        };
      });

      res.json({ success: true, results });
    } catch (e) {
      res.json({ success: false, error: stderr || e.message, results: [] });
    }
  });
});

app.post('/api/run-all/:marca', (req, res) => {
  const { marca } = req.params;
  const { testUrl, gtmPreviewUrl } = req.body;

  const env = {
    ...process.env,
    ...(testUrl       && { TEST_URL: testUrl }),
    ...(gtmPreviewUrl && { GTM_PREVIEW_URL: gtmPreviewUrl }),
  };

  execFile(process.execPath, [playwrightCli(), 'test', `tests/${marca}`, '--reporter=json'], { cwd: __dirname, env, maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
    try {
      const raw   = JSON.parse(stdout);
      const specs = raw.suites?.flatMap(s => s.specs ?? []) ?? [];
      res.json({ success: true, results: specs.map(s => ({
        name:   s.title,
        status: s.tests?.[0]?.results?.[0]?.status ?? 'failed',
      }))});
    } catch {
      res.json({ success: false, error: 'Erro ao parsear resultado', results: [] });
    }
  });
});

// ─── ROTAS DE GRAVAÇÃO ────────────────────────────────────────────────────────

app.post('/api/start-recording', (req, res) => {
  const { url } = req.body;
  if (recordingStatus === 'recording') return res.status(400).json({ error: 'Gravação já em andamento' });
  recordingStatus = 'recording';
  res.json({ success: true, message: 'Gravação iniciada' });
});

app.get('/api/recording-status', (req, res) => {
  res.json({ status: recordingStatus });
});

app.post('/api/save-recording', async (req, res) => {
  const { marca, nome, actions, startUrl } = req.body;
  if (!marca || !nome)  return res.status(400).json({ error: 'marca e nome são obrigatórios' });
  if (!actions?.length) return res.status(400).json({ error: 'Nenhuma ação gravada' });

  const dir = path.join(__dirname, 'tests', marca);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const configPathCheck = path.join(__dirname, 'tests', marca, 'config.json');
  if (!fs.existsSync(configPathCheck)) {
    return res.status(400).json({
      error: `A marca "${marca}" não tem configuração. Configure o domínio sGTM antes de salvar fluxos.`
    });
  }

  const fileName = nome.toLowerCase()
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-')
    .trim() + '.spec.js';

  const url       = startUrl || '';
  const hasConfig = fs.existsSync(path.join(__dirname, 'tests', marca, 'config.json'));
  const acoes     = actions.map(a => '  ' + a).join('\n');

  const spec = `const { test } = require('@playwright/test');
const { setupDataLayerCapture, getDataLayerEvents } = require('../../dl-capture');
const { setupGA4Capture } = require('../../ga4-capture');
const { printReport } = require('../../validator');
const { printComparacao } = require('../../ga4-comparator');
${hasConfig ? `const config = require('./config.json');` : ''}

const BASE_URL    = process.env.TEST_URL || '${url}';
const GTM_PREVIEW = process.env.GTM_PREVIEW_URL || null;

test('${nome}', async ({ page }) => {
  test.setTimeout(60000);

  await setupDataLayerCapture(page);
  const ga4Events = await setupGA4Capture(page, ${hasConfig ? 'config.sgtm' : 'null'});

  if (GTM_PREVIEW) {
    await page.goto(GTM_PREVIEW);
    await page.waitForTimeout(2000);
  }

  await page.goto(BASE_URL);
${acoes}

  await page.waitForTimeout(3000);

  const dlEvents = await getDataLayerEvents(page);

  printReport(dlEvents);

  console.log('\\n===== EVENTOS GA4 CAPTURADOS =====');
  if (ga4Events.length === 0) {
    console.log('Nenhum evento GA4 interceptado');
  } else {
    ga4Events.forEach((e, i) => {
      console.log(\`[GA4-\${i + 1}]##\${JSON.stringify(e.event)}\`);
    });
    console.log(\`\\nTotal GA4: \${ga4Events.length} eventos capturados\`);
  }

  printComparacao(dlEvents, ga4Events, ${hasConfig ? 'config.eventMap ?? {}' : '{}'});
});
`;

  fs.writeFileSync(path.join(dir, fileName), spec);
  recordingStatus = 'idle';

  res.json({ success: true, file: `tests/${marca}/${fileName}` });

  try {
    const result = await commitToGitHub(
      `tests/${marca}/${fileName}`,
      spec,
      `feat: adiciona fluxo "${nome}" para ${marca}`
    );
    console.log('GitHub commit:', result?.commit?.sha ?? JSON.stringify(result)?.slice(0, 100));
  } catch (e) {
    console.error('GitHub commit erro:', e.message);
  }
});

app.post('/api/cancel-recording', (req, res) => {
  recordingStatus = 'idle';
  res.json({ success: true });
});
// Exclui fluxo do servidor e do GitHub
// ── Deletar fluxo gravado (fonte de verdade: GitHub) ─────────────────────
app.delete('/api/flows/:marca/:flowId', async (req, res) => {
  const { marca, flowId } = req.params;
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  // Remove do disco local se existir
  const flowPath = path.join(__dirname, 'flows', marca, `${flowId}.json`);
  if (fs.existsSync(flowPath)) fs.unlinkSync(flowPath);

  // Remove do GitHub
  if (token && repo) {
    try {
      const githubPath = `flows/${marca}/${flowId}.json`;
      const baseUrl = `https://api.github.com/repos/${repo}/contents/${githubPath}`;
      const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests', 'Content-Type': 'application/json' };
      const getResp = await fetch(baseUrl, { headers });
      if (getResp.ok) {
        const data = await getResp.json();
        const delResp = await fetch(baseUrl, {
          method: 'DELETE', headers,
          body: JSON.stringify({ message: `flow: remove ${flowId} de ${marca}`, sha: data.sha, branch }),
        });
        if (!delResp.ok) {
          const err = await delResp.json().catch(() => ({}));
          return res.status(500).json({ error: 'Erro ao remover do GitHub: ' + (err.message ?? 'desconhecido') });
        }
      } else {
        return res.status(404).json({ error: 'Fluxo não encontrado no GitHub' });
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  res.json({ success: true });
});
app.delete('/api/fluxos/:marca/:flowId', async (req, res) => {
  // mantido para compatibilidade
  res.redirect(307, `/api/flows/${req.params.marca}/${req.params.flowId}`);
});
// Recebe sessão capturada pela extensão e valida
// DESCARTA page_view NA ENTRADA para toda origem.
//
// O `page_view` da marca-a carrega um objeto `ecommerce` de 363 KB POR DISPARO — 2,1 MB só
// desse evento numa sessão de 120, contra 5 KB do view_item_list inteiro. Jornada longa
// enchia a sessão de peso inútil. ATENÇÃO: este filtro NÃO resolve o 413 — foi o que se
// acreditou em 2026-10-27 e é falso. express.json é middleware e rejeita o corpo antes de
// qualquer rota, então quem destrava o salvamento é o limite lá em cima, não este filtro. Aqui
// só se decide o que vai para o arquivo.
//
// Filtrar AQUI e não no cliente é o que resolve para a captura manual: a extensão monta o
// payload no navegador e não passa por nenhum filtro nosso. Feito no endpoint, vale para quem
// quer que esteja gravando.
//
// `page_view` NÃO está no Mapa de Tags (conferido no schema.json): não é validado nem usado
// pela área de saúde, então descartar não perde nada avaliável. Decisão do usuário em
// 2026-10-27.
//
// O defeito em si segue existindo e vale reportar à marca — page_view não deveria carregar
// ecommerce, e esse volume vai inteiro para o GA4 em toda visualização de página.
const EVENTOS_FORA_DA_GRAVACAO = new Set(['page_view', 'PageView']);

// Mesmo descarte, lendo o nome no formato do hit de GA4 (event_name, às vezes aninhado em
// `event`), que é diferente do formato do dataLayer.
const semPageViewGA4 = (eventos) => (eventos ?? []).filter(e => {
  const inner = (e && e.event && typeof e.event === 'object') ? e.event : e;
  const nome  = (inner && (inner.event_name ?? inner.event)) ?? e.event_name;
  return !EVENTOS_FORA_DA_GRAVACAO.has(nome);
});

const semPageView = (eventos) => (eventos ?? []).filter(e => {
  const nome = e && e.event && e.event.event;
  return !EVENTOS_FORA_DA_GRAVACAO.has(nome);
});

app.post('/api/save-session', async (req, res) => {
  const { marca, nome, testador, startUrl, parceiros } = req.body;
  const dlEvents = semPageView(req.body.dlEvents);
  // Também do lado do GA4. O semPageView original só limpava o dataLayer, e metade do lixo
  // ficava: na sessão medida, `page_view` pesa 3,58 MB dentro de ga4Events, praticamente o
  // mesmo que em dlEvents. Fora o tamanho, a assimetria era pior — o evento sumia de um lado e
  // ficava no outro, e o comparador passava a apontar "hit no GA4 sem push no dataLayer" para
  // um evento que o próprio servidor tinha removido.
  const ga4Limpos = semPageViewGA4(req.body.ga4Events);
  if (!marca || !nome) return res.status(400).json({ error: 'marca e nome sao obrigatorios' });

  let validacao, inconsistencias, comparacao;
  try {
    const { validateAll, verificarConsistencia } = require('./validator');
    const { compareAll }                         = require('./ga4-comparator');
    const configPath = path.join(__dirname, 'tests', marca, 'config.json');
    const config     = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath)) : {};
    validacao       = validateAll(dlEvents ?? [], ga4Limpos ?? []);
    inconsistencias = verificarConsistencia(dlEvents ?? []);
    comparacao      = compareAll(dlEvents ?? [], ga4Limpos ?? [], config.eventMap ?? {});
  } catch (e) {
    console.error('Erro na validacao ao salvar sessao:', e.message);
    // Sem o erroValidacao, uma exceção aqui gravava resumo zerado + eventos vazios, e o
    // relatório lia "0 falhas" e carimbava "✅ Aprovado" numa sessão que nunca chegou a ser
    // validada. Registrar o erro é o que permite distinguir "nada de errado" de "não deu
    // para olhar" — eram indistinguíveis no arquivo salvo.
    validacao       = {
      summary: { total: 0, passed: 0, failed: 0, unknown: 0, erros: 0, ga4Failed: 0, ga4Ausente: 0 },
      eventos: [],
      erroValidacao: e.message || String(e),
    };
    inconsistencias = [];
    comparacao      = [];
  }

  const sessao = {
    nome,
    marca,
    testador: testador || 'Não informado',
    startUrl,
    timestamp:      new Date().toISOString(),
    dlEvents:       dlEvents  ?? [],
    ga4Events:      normalizeGA4Events(ga4Limpos ?? []),
    parceiros:      parceiros ?? [],
    validacao,
    inconsistencias,
    comparacao,
  };

  const fileName    = nome.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now() + '.json';

  // `pasta` é OPCIONAL — quando omitida, a sessão cai em sessions/<marca>/ como padrão.
  // Quando informada, permite organizar sessões em subpastas separadas.
  // O valor é saneado: só letras, números, hífen, underscore e barra, sem "..". Sem isso, um
  // `pasta` malicioso ou com erro de digitação escreveria em qualquer lugar do disco.
  const pastaPedida = typeof req.body.pasta === 'string' ? req.body.pasta : null;
  const pastaSegura = pastaPedida
    && !pastaPedida.includes('..')
    && /^[A-Za-z0-9_\-/À-ÿ ]+$/.test(pastaPedida)
    ? pastaPedida.replace(/^\/+|\/+$/g, '')
    : null;

  const destino     = pastaSegura ?? `sessions/${marca}`;
  const filePath    = `${destino}/${fileName}`;
  const fileContent = JSON.stringify(sessao, null, 2);

  fs.mkdirSync(path.join(__dirname, destino), { recursive: true });
  fs.writeFileSync(path.join(__dirname, destino, fileName), fileContent);

  recordingStatus = 'idle';
  res.json({ success: true, file: filePath });

  try {
    const result = await commitToGitHub(filePath, fileContent, `session: ${nome} (${marca})`);
    console.log('Session commit:', result?.commit?.sha?.slice(0, 8));
  } catch (e) {
    console.error('Session commit erro:', e.message);
  }
});

// ─── GERA PDF DO RELATÓRIO DE UMA SESSÃO ─────────────────────────────────────
app.get('/api/sessions/:marca/:sessionId/pdf', async (req, res) => {
  const { marca, sessionId } = req.params;

  // Carrega dados da sessão
  let sessao;
  const localPath = path.join(__dirname, 'sessions', marca, `${sessionId}.json`);
  if (fs.existsSync(localPath)) {
    sessao = JSON.parse(fs.readFileSync(localPath));
  } else {
    const token = process.env.GITHUB_TOKEN;
    const repo  = process.env.GITHUB_REPO;
    if (!token || !repo) return res.status(404).json({ error: 'Sessão não encontrada' });
    try {
      const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
      const branch  = process.env.GITHUB_BRANCH ?? 'main';
      const metaResp = await fetch(`https://api.github.com/repos/${repo}/contents/sessions/${marca}/${sessionId}.json?ref=${branch}`, { headers });
      if (!metaResp.ok) return res.status(404).json({ error: 'Sessão não encontrada' });
      const meta = await metaResp.json();
      if (meta.content) {
        sessao = JSON.parse(Buffer.from(meta.content, 'base64').toString());
      } else if (meta.download_url) {
        const dlResp = await fetch(meta.download_url, { headers });
        sessao = await dlResp.json();
      } else {
        return res.status(404).json({ error: 'Sessão não encontrada' });
      }
    } catch (e) {
      return res.status(500).json({ error: 'Erro ao buscar sessão para PDF: ' + e.message });
    }
  }

  try {
    const { chromium } = require('@playwright/test');
    // Inicia Xvfb — display virtual com interface gráfica real
    // Permite hover CSS, animações e interações que não funcionam em headless
    let xvfbProc = null;
    const display = ':' + (99 + Math.floor(Math.random() * 100));
    try {
      const { spawn } = require('child_process');
      xvfbProc = spawn('Xvfb', [display, '-screen', '0', '1280x720x24', '-ac'], {
        detached: true, stdio: 'ignore'
      });
      xvfbProc.unref();
      await new Promise(r => setTimeout(r, 800));
    } catch {}

    const useHeaded = !!xvfbProc;
    if (useHeaded) process.env.DISPLAY = display;

    const browser = await chromium.launch({
      headless: !useHeaded,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        ...(useHeaded ? ['--disable-gpu'] : []),
      ],
    });
    const page    = await browser.newPage({ viewport: { width: 1200, height: 900 } });

    let html;
    try {
      html = gerarHTMLRelatorio(sessao);
    } catch (htmlErr) {
      console.error('PDF gerarHTML error:', htmlErr.message, htmlErr.stack?.slice(0,300));
          await browser.close();
    // Mata o Xvfb após uso
    if (xvfbProc) try { process.kill(-xvfbProc.pid); } catch {}
      return res.status(500).json({ error: 'Erro ao gerar HTML do relatório: ' + htmlErr.message });
    }
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdf = await page.pdf({
      format:           'A4',
      printBackground:  true,
      margin:           { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    });
    await browser.close();

    const nomeArquivo = `relatorio-${sessao.nome?.replace(/\s+/g, '-') ?? sessionId}-${marca}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.send(pdf);
  } catch (e) {
    console.error('PDF error:', e.message);
    res.status(500).json({ error: 'Erro ao gerar PDF: ' + e.message });
  }
});

// ─── PARÂMETROS POR EVENTO (dataLayer x GA4) ───────────────────────────────
// Achata um objeto em pares chave/valor legíveis para exibição em tabela.
// Objetos/arrays viram JSON compacto; ignora chaves de controle internas.
function flattenParams(obj, prefix = '') {
  const IGNORAR = new Set(['event', 'event_name', 'timestamp', '_ga4']);
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!prefix && IGNORAR.has(k)) continue;
    const chave = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenParams(v, chave));
    } else if (Array.isArray(v)) {
      out.push({ k: chave, v: JSON.stringify(v) });
    } else {
      out.push({ k: chave, v: String(v) });
    }
  }
  return out;
}

// Monta a tabela de parâmetros (lado dataLayer ou lado GA4) de um único evento.
function gerarTabelaParams(pares) {
  if (!pares.length) return '<div class="empty" style="padding:6px">Sem parâmetros</div>';
  const linhas = pares.map(p =>
    `<tr><td style="font-weight:600;color:#475569">${esc(p.k)}</td><td>${esc(p.v)}</td></tr>`
  ).join('');
  return `<table class="params-table"><tr><th>Parâmetro</th><th>Valor</th></tr>${linhas}</table>`;
}

// Monta o bloco completo (DL + GA4 lado a lado) para um evento já pareado.
// Função isolada para evitar template literals aninhados demais (erros de sintaxe).
function gerarBlocoEventoUnico(nome, horario, dlParams, ga4Params, status) {
  const tabelaDL  = gerarTabelaParams(dlParams);
  const tabelaGA4 = gerarTabelaParams(ga4Params);
  const badge = status === 'ok'
    ? '<span style="color:#16a34a;font-size:11px">✅ ok</span>'
    : status === 'sem_ga4'
      ? '<span style="color:#dc2626;font-size:11px">🚫 não capturado no GA4</span>'
      : status === 'sem_dl'
        ? '<span style="color:#dc2626;font-size:11px">🚫 sem correspondência no dataLayer</span>'
        : '<span style="color:#d97706;font-size:11px">⚠️ divergências</span>';
  return `
    <div class="event-param-block">
      <div class="event-param-title">${esc(nome)} <span style="font-weight:400;color:#94a3b8;font-size:11px">${horario}</span> ${badge}</div>
      <div class="params-grid">
        <div>
          <div class="params-col-label">dataLayer</div>
          ${tabelaDL}
        </div>
        <div>
          <div class="params-col-label">GA4</div>
          ${tabelaGA4}
        </div>
      </div>
    </div>`;
}

// Para cada evento do dataLayer, encontra o hit GA4 de mesmo nome mais próximo
// no tempo (janela de 5s, igual ao critério usado no dashboard) e gera o bloco.
// modoSelecao = true: usado em PDFs de recorte (eventos selecionados). Nesse caso
// percorremos a partir dos GA4 selecionados (que são ocorrências exatas, por índice)
// em vez dos DL (que o front filtra só por nome e pode trazer ocorrências a mais).
function gerarBlocoEventos(dlEvents, ga4Events, modoSelecao = false) {
  const dlUsados  = new Set();
  const blocos    = [];

  function montarBloco(dlEvent, ga4Event, nomeFallback) {
    const dlData    = dlEvent ? (dlEvent.event ?? dlEvent) : null;
    const nome      = dlData?.event ?? dlData?.event_name ?? nomeFallback ?? '(evento sem nome)';
    const ga4Parsed = ga4Event ? (ga4Event.event ?? ga4Event) : null;
    const dlParams  = dlData ? flattenParams(dlData) : [];
    const ga4Params = ga4Parsed ? flattenParams(ga4Parsed.params ?? ga4Parsed) : [];
    const tsDL      = dlEvent?.timestamp ?? null;
    const horario   = tsDL ? new Date(tsDL).toLocaleTimeString('pt-BR') : '';
    const status    = !dlEvent ? 'sem_dl' : !ga4Event ? 'sem_ga4' : 'ok';
    return gerarBlocoEventoUnico(nome, horario, dlParams, ga4Params, status);
  }

  if (modoSelecao) {
    // Um bloco por evento GA4 efetivamente selecionado — encontra o DL correspondente
    // (mesmo nome, timestamp mais próximo) sem deixar ocorrências extras vazarem.
    (ga4Events ?? []).forEach((g) => {
      const gName = g.event?.event_name ?? g.event_name;
      const tsGA4 = g.timestamp ?? null;

      let melhorIdx = -1, melhorDiff = Infinity;
      (dlEvents ?? []).forEach((dl, di) => {
        if (dlUsados.has(di)) return;
        const dlData = dl.event ?? dl;
        const dlNome = dlData.event ?? dlData.event_name;
        if (dlNome !== gName) return;
        const tsDL = dl.timestamp ?? null;
        const diff = (tsDL && tsGA4) ? Math.abs(tsGA4 - tsDL) : 0;
        if (diff < melhorDiff && diff <= 5000) { melhorDiff = diff; melhorIdx = di; }
      });

      const dlMatch = melhorIdx >= 0 ? dlEvents[melhorIdx] : null;
      if (melhorIdx >= 0) dlUsados.add(melhorIdx);
      blocos.push(montarBloco(dlMatch, g, gName));
    });

    // Eventos do recorte que existem só no dataLayer (sem nenhum GA4 selecionado) —
    // ex.: pares de promoção, onde ga4Events vem vazio de propósito. Só roda quando
    // o recorte é guiado pelo DL (sem GA4 nenhum); caso contrário, ocorrências do
    // mesmo nome que não bateram com o GA4 selecionado são descartadas (não eram a selecionada).
    if (!(ga4Events ?? []).length) {
      (dlEvents ?? []).forEach((dl, di) => {
        if (dlUsados.has(di)) return;
        blocos.push(montarBloco(dl, null));
      });
    }

    return blocos.join('');
  }

  // Modo sessão completa: percorre todos os eventos do dataLayer, como antes.
  const ga4Usados = new Set();
  (dlEvents ?? []).forEach((dl) => {
    const dlData = dl.event ?? dl;
    const nome   = dlData.event ?? dlData.event_name;
    const tsDL   = dl.timestamp ?? null;

    let melhorIdx = -1, melhorDiff = Infinity;
    (ga4Events ?? []).forEach((g, gi) => {
      if (ga4Usados.has(gi)) return;
      const gName = g.event?.event_name ?? g.event_name;
      if (gName !== nome) return;
      const tsGA4 = g.timestamp ?? null;
      const diff = (tsDL && tsGA4) ? Math.abs(tsGA4 - tsDL) : 0;
      if (diff < melhorDiff && diff <= 5000) { melhorDiff = diff; melhorIdx = gi; }
    });

    const ga4Match = melhorIdx >= 0 ? ga4Events[melhorIdx] : null;
    if (melhorIdx >= 0) ga4Usados.add(melhorIdx);
    blocos.push(montarBloco(dl, ga4Match, nome));
  });

  return blocos.join('');
}

function gerarHTMLRelatorio(s) {
  const data    = s.timestamp ? new Date(s.timestamp).toLocaleString('pt-BR') : '';
  const summary = s.validacao?.summary ?? {};
  const total   = summary.total   ?? 0;
  const passed  = summary.passed  ?? 0;
  const failed  = summary.failed  ?? 0;
  const unknown = summary.unknown ?? 0;
  const incTotal = s.inconsistencias?.length ?? 0;
  // ga4Failed entra na aprovação porque o resumo só contava o lado dataLayer: uma sessão
  // cujo hit chegou ao GA4 sem parâmetro nenhum saía "✅ Aprovado". Só 'falhou' entra —
  // 'ausente' (não encontrado) é historicamente falso-negativo de captura e não reprova.
  // Sessões gravadas antes desta mudança não têm o campo no summary, mas têm o veredito
  // por evento em validacao.eventos[].ga4 — contar de lá faz o relatório parar de mentir
  // nelas também, em vez de só nas novas.
  const ga4Failed = summary.ga4Failed
    ?? (s.validacao?.eventos ?? []).filter(e => e.ga4?.status === 'falhou').length;
  // Sessão cuja validação estourou não é aprovada nem reprovada — ela não foi avaliada, e
  // dizer qualquer uma das duas coisas é mentir. Ver o catch em /api/save-session.
  const erroValidacao = s.validacao?.erroValidacao ?? null;
  const aprovado = !erroValidacao && failed === 0 && incTotal === 0 && ga4Failed === 0;
  const statusGeral = erroValidacao ? '⚠️ Validação não concluída'
                    : aprovado      ? '✅ Aprovado'
                                    : '❌ Requer atenção';
  const statusColor = erroValidacao ? '#d97706' : aprovado ? '#16a34a' : '#dc2626';

  // Inconsistências entre eventos
  const incRows = (s.inconsistencias ?? []).map(inc => `
    <tr>
      <td>${esc(inc.item_name ?? '')}</td>
      <td>${esc(inc.item_id ?? '')}</td>
      <td>${esc(inc.campo ?? '')}</td>
      <td>${esc(inc.evento_origem ?? '')}</td>
      <td class="val-bad">${esc(String(inc.valor_origem ?? ''))}</td>
      <td>${esc(inc.evento_atual ?? '')}</td>
      <td class="val-bad">${esc(String(inc.valor_atual ?? ''))}</td>
    </tr>`).join('');

  // Erros de schema AGRUPADOS — evita repetição de erros idênticos
  const erroMap = {};
  (s.validacao?.eventos ?? []).filter(ev => ev.errors?.length > 0).forEach(ev => {
    ev.errors.forEach(e => {
      const key = `${ev.event}||${e}`;
      erroMap[key] = (erroMap[key] ?? { event: ev.event, erro: e, count: 0 });
      erroMap[key].count++;
    });
  });
  const erroRows = Object.values(erroMap).map(({ event, erro, count }) => `
    <tr>
      <td>${esc(event)}</td>
      <td class="val-bad">${esc(erro)}</td>
      <td style="text-align:center;color:#666">${count > 1 ? `<span style="background:#f1f5f9;padding:2px 7px;border-radius:10px;font-size:11px">${count}x</span>` : '—'}</td>
    </tr>`).join('');

  // Comparação DL vs GA4 AGRUPADA — agrupa eventos com mesmo status e erro
  const cmpMap = {};
  (s.comparacao ?? []).forEach(c => {
    const divStr = c.divergencias?.join(' | ') ?? '';
    const key = `${c.dlEvent}||${c.status}||${divStr}`;
    if (!cmpMap[key]) cmpMap[key] = { ...c, count: 0 };
    cmpMap[key].count++;
  });
  const cmpRows = Object.values(cmpMap).map(c => {
    const icon  = c.status === 'ok' ? '✅' : c.status === 'nao_chegou_ga4' ? '🚫' : '⚠️';
    const divs  = c.divergencias?.filter(d => !d.includes('Pode ser limitação')).map(d => esc(d)).join('<br>') ?? '';
    return `<tr>
      <td>${esc(c.dlEvent ?? '')}${c.count > 1 ? ` <span style="background:#f1f5f9;padding:2px 7px;border-radius:10px;font-size:11px">${c.count}x</span>` : ''}</td>
      <td>${icon} ${esc(c.status === 'ok' ? 'ok' : c.status === 'nao_chegou_ga4' ? 'não chegou ao GA4' : 'divergências')}</td>
      <td style="font-size:11px;color:#666">${divs}</td>
    </tr>`;
  }).join('');

  // Eventos GA4 capturados AGRUPADOS
  const ga4Map = {};
  (s.ga4Events ?? []).forEach(ev => {
    const name = ev.event?.event_name ?? ev.event_name ?? '';
    ga4Map[name] = (ga4Map[name] ?? 0) + 1;
  });
  const ga4Rows = Object.entries(ga4Map).map(([name, count]) =>
    `<tr><td>${esc(name)}</td><td style="text-align:center;color:#666">${count > 1 ? `<span style="background:#f1f5f9;padding:2px 7px;border-radius:10px;font-size:11px">${count}x</span>` : '—'}</td></tr>`
  ).join('');

  // Detalhamento AGRUPADO por evento
  const detMap = {};
  (s.validacao?.eventos ?? []).forEach(ev => {
    const key = ev.event;
    if (!detMap[key]) detMap[key] = { event: ev.event, status: ev.status, errors: new Set(), warnings: new Set(), passedCount: 0, count: 0 };
    detMap[key].count++;
    detMap[key].passedCount += ev.passed?.length ?? 0;
    ev.errors?.forEach(e => detMap[key].errors.add(e));
    ev.warnings?.forEach(w => detMap[key].warnings.add(w));
    if (ev.status === 'falhou') detMap[key].status = 'falhou';
  });
  const detRows = Object.values(detMap).map(ev => `
    <tr>
      <td><strong>${esc(ev.event)}</strong>${ev.count > 1 ? ` <span style="background:#f1f5f9;padding:2px 7px;border-radius:10px;font-size:11px">${ev.count}x</span>` : ''}</td>
      <td>${ev.status === 'passou' ? '<span style="color:#16a34a">✅ passou</span>' : ev.status === 'falhou' ? '<span style="color:#dc2626">❌ falhou</span>' : '❓'}</td>
      <td style="font-size:11px;color:#dc2626">${[...ev.errors].join('<br>') || '—'}</td>
      <td style="font-size:11px;color:#d97706">${[...ev.warnings].join('<br>') || '—'}</td>
      <td style="font-size:11px;color:#16a34a">${ev.passedCount} ok</td>
    </tr>`).join('');

  // Detalhamento de parâmetros por evento: quando o PDF é um recorte
  // (eventos selecionados, pares de promoção, etc.) restringe o detalhamento
  // apenas aos eventos efetivamente presentes nesse recorte — não na sessão inteira.
  let dlEventsParaDetalhe = s.dlEvents ?? [];
  if (s._filtro) {
    const nomesSelecionados = new Set();
    (s.validacao?.eventos ?? []).forEach(ev => { if (ev.event) nomesSelecionados.add(ev.event); });
    (s.comparacao ?? []).forEach(c => {
      if (c.dlEvent)  nomesSelecionados.add(c.dlEvent);
      if (c.ga4Event) nomesSelecionados.add(c.ga4Event);
      if (c.dlPar)    nomesSelecionados.add(c.dlPar);
    });
    (s.ga4Events ?? []).forEach(ev => {
      const n = ev.event?.event_name ?? ev.event_name;
      if (n) nomesSelecionados.add(n);
    });
    if (nomesSelecionados.size > 0) {
      dlEventsParaDetalhe = dlEventsParaDetalhe.filter(dl => {
        const nome = dl.event?.event ?? dl.event;
        return nomesSelecionados.has(nome);
      });
    }
  }

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Arial, sans-serif; font-size: 13px; color: #1a1a1a; background: #fff; }
  .header { background: #0f172a; color: #fff; padding: 28px 32px; margin-bottom: 24px; }
  .header h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
  .header .sub { font-size: 13px; color: #94a3b8; }
  .header .meta { display: flex; gap: 32px; margin-top: 16px; font-size: 12px; color: #cbd5e1; }
  .status-badge { display: inline-block; padding: 6px 16px; border-radius: 20px; font-size: 15px; font-weight: 700; color: #fff; background: ${statusColor}; margin-bottom: 20px; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .summary-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px; text-align: center; }
  .summary-card .num { font-size: 28px; font-weight: 700; }
  .summary-card .lbl { font-size: 11px; color: #64748b; margin-top: 4px; }
  .section { margin-bottom: 28px; }
  .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #475569; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #f8fafc; text-align: left; padding: 8px 10px; font-weight: 600; color: #475569; border-bottom: 1px solid #e2e8f0; }
  td { padding: 7px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .val-bad { color: #dc2626; font-weight: 500; }
  .val-ok  { color: #16a34a; }
  .empty   { color: #94a3b8; font-style: italic; padding: 12px; }
  .page-break { page-break-before: always; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center; }
  .event-param-block { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; page-break-inside: avoid; }
  .event-param-title { font-weight: 700; font-size: 13px; margin-bottom: 8px; }
  .params-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .params-col-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #64748b; margin-bottom: 4px; }
  .params-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .params-table th { background: #f8fafc; text-align: left; padding: 5px 8px; font-weight: 600; color: #475569; border-bottom: 1px solid #e2e8f0; }
  .params-table td { padding: 5px 8px; border-bottom: 1px solid #f1f5f9; word-break: break-word; }
</style>
</head>
<body>

<div class="header">
  <h1>Relatório de Validação — ${esc(s.marca?.toUpperCase() ?? '')}</h1>
  <div class="sub">DataLayer Test Runner · Soma Group${s._filtro ? ' · Filtro: ' + esc(s._filtro) : ''}</div>
  <div class="meta">
    <span>📋 Sessão: <strong>${esc(s.nome ?? '')}</strong></span>
    <span>👤 Testador: <strong>${esc(s.testador ?? 'Não informado')}</strong></span>
    <span>📅 Data: <strong>${data}</strong></span>
    <span>🔗 URL: <strong>${esc(s.startUrl ?? '')}</strong></span>
  </div>
</div>

<div style="padding: 0 32px">

<div class="status-badge">${statusGeral}</div>

<div class="summary-grid">
  <div class="summary-card">
    <div class="num">${total}</div>
    <div class="lbl">Eventos DL</div>
  </div>
  <div class="summary-card">
    <div class="num" style="color:#16a34a">${passed}</div>
    <div class="lbl">Passaram</div>
  </div>
  <div class="summary-card">
    <div class="num" style="color:#dc2626">${failed}</div>
    <div class="lbl">Com erro</div>
  </div>
  <div class="summary-card">
    <div class="num" style="color:#d97706">${incTotal}</div>
    <div class="lbl">Inconsistências</div>
  </div>
</div>

<!-- INCONSISTÊNCIAS ENTRE EVENTOS -->
<div class="section">
  <div class="section-title">Inconsistências entre eventos</div>
  ${incTotal === 0
    ? '<div class="empty">Nenhuma inconsistência encontrada ✅</div>'
    : `<table>
        <tr><th>Produto</th><th>ID</th><th>Campo</th><th>Evento origem</th><th>Valor origem</th><th>Evento atual</th><th>Valor atual</th></tr>
        ${incRows}
       </table>`
  }
</div>

<!-- ERROS DE SCHEMA -->
<div class="section">
  <div class="section-title">Erros de schema (campos ausentes ou tipo errado)</div>
  ${erroRows
    ? `<table><tr><th>Evento</th><th>Erro</th><th style="width:50px">Qtd</th></tr>${erroRows}</table>`
    : '<div class="empty">Nenhum erro de schema ✅</div>'
  }
</div>

<!-- COMPARAÇÃO DL vs GA4 -->
<div class="section">
  <div class="section-title">Comparação dataLayer vs GA4</div>
  ${cmpRows
    ? `<table><tr><th>Evento DL</th><th>Status</th><th>Divergências</th></tr>${cmpRows}</table>`
    : '<div class="empty">Nenhuma comparação disponível</div>'
  }
</div>

<div class="page-break"></div>

<!-- DETALHAMENTO COMPLETO -->
<div class="section">
  <div class="section-title">Detalhamento — eventos dataLayer (agrupado)</div>
  <table>
    <tr><th>Evento</th><th>Status</th><th>Erros</th><th>Avisos</th><th>OK</th></tr>
    ${detRows}
  </table>
</div>

<!-- GA4 CAPTURADO -->
<div class="section">
  <div class="section-title">GA4 capturado (${s.ga4Events?.length ?? 0} eventos)</div>
  ${ga4Rows
    ? `<table><tr><th>Evento GA4</th><th style="width:50px">Qtd</th></tr>${ga4Rows}</table>`
    : '<div class="empty">Nenhum evento GA4 capturado</div>'
  }
</div>

<div class="page-break"></div>

<!-- PARÂMETROS POR EVENTO: dataLayer x GA4 -->
<div class="section">
  <div class="section-title">Parâmetros por evento (dataLayer × GA4)</div>
  ${dlEventsParaDetalhe.length || (s._filtro && (s.ga4Events ?? []).length)
    ? gerarBlocoEventos(dlEventsParaDetalhe, s.ga4Events, !!s._filtro)
    : '<div class="empty">Nenhum evento de dataLayer disponível para detalhamento</div>'
  }
</div>

<div class="footer">Gerado automaticamente pelo DataLayer Test Runner · ${new Date().toLocaleString('pt-BR')}</div>
</div>
</body>
</html>`;
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Lista sessões de uma marca
// Lista pastas existentes de uma marca (derivadas das sessões já salvas)
app.get('/api/folders/:marca', async (req, res) => {
  const { marca } = req.params;
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const pastas = new Set();

  try {
    if (!token || !repo) {
      const dir = path.join(__dirname, 'sessions', marca);
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, f)));
            if (data.pasta) pastas.add(data.pasta);
          } catch {}
        }
      }
      return res.json([...pastas].sort());
    }

    const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
    const resp = await fetch(`https://api.github.com/repos/${repo}/contents/sessions/${marca}?ref=${branch}`, { headers });
    if (!resp.ok) return res.json([]);
    const files = await resp.json();
    await Promise.all(files.filter(f => f.name.endsWith('.json')).map(async f => {
      try {
        const r = await fetch(f.download_url, { headers });
        if (!r.ok) return;
        const d = await r.json();
        if (d.pasta) pastas.add(d.pasta);
      } catch {}
    }));
    res.json([...pastas].sort());
  } catch {
    res.json([]);
  }
});

// Move uma sessão para uma pasta (ou remove da pasta com pasta: null)
app.patch('/api/sessions/:marca/:sessionId/pasta', async (req, res) => {
  const { marca, sessionId } = req.params;
  const { pasta } = req.body;
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const localPath = path.join(__dirname, 'sessions', marca, `${sessionId}.json`);

  try {
    if (!token || !repo) {
      if (!fs.existsSync(localPath)) return res.status(404).json({ error: 'Sessão não encontrada' });
      const data = JSON.parse(fs.readFileSync(localPath));
      data.pasta = pasta ?? null;
      fs.writeFileSync(localPath, JSON.stringify(data, null, 2));
      return res.json({ ok: true, pasta: data.pasta });
    }

    const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
    const filePath = `sessions/${marca}/${sessionId}.json`;
    const metaResp = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`, { headers });
    if (!metaResp.ok) return res.status(404).json({ error: 'Sessão não encontrada' });
    const meta = await metaResp.json();
    let data;
    if (meta.content) {
      data = JSON.parse(Buffer.from(meta.content, 'base64').toString());
    } else if (meta.download_url) {
      const dlResp = await fetch(meta.download_url, { headers });
      data = await dlResp.json();
    } else {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }
    data.pasta = pasta ?? null;
    await commitToGitHub(filePath, JSON.stringify(data, null, 2), `Move sessão ${sessionId} para pasta "${pasta ?? '(raiz)'}"`);
    res.json({ ok: true, pasta: data.pasta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sessions/:marca', async (req, res) => {
  const { marca } = req.params;
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token || !repo) {
    const dir = path.join(__dirname, 'sessions', marca);
    if (!fs.existsSync(dir)) return res.json([]);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const sessions = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f)));
      return { id: f.replace('.json', ''), nome: data.nome, timestamp: data.timestamp, dlCount: data.dlEvents?.length ?? 0, ga4Count: data.ga4Events?.length ?? 0, validacao: data.validacao?.summary, _fromFlow: data._fromFlow ?? null, pasta: data.pasta ?? null, ambiente: data.ambiente ?? 'web' };
    }).filter(s => s.ambiente !== 'app');
    return res.json(sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
  }

  try {
    const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
    const resp = await fetch(`https://api.github.com/repos/${repo}/contents/sessions/${marca}?ref=${branch}`, { headers });
    if (!resp.ok) return res.json([]);
    const files = await resp.json();

    // Busca detalhes reais de cada sessão (timestamp, contagens, resumo)
    const sessions = await Promise.all(
      files.filter(f => f.name.endsWith('.json')).map(async f => {
        try {
          const dlResp = await fetch(f.download_url, { headers });
          if (!dlResp.ok) throw new Error('download failed');
          const data = await dlResp.json();
          return {
            id:        f.name.replace('.json', ''),
            nome:      data.nome ?? f.name.replace(/-\d+\.json$/, '').replace(/-/g, ' '),
            timestamp: data.timestamp ?? new Date(0).toISOString(),
            dlCount:   data.dlEvents?.length  ?? 0,
            ga4Count:  data.ga4Events?.length ?? 0,
            validacao: data.validacao?.summary ?? null,
            _fromFlow: data._fromFlow ?? null,
            pasta:     data.pasta ?? null,
            ambiente:  data.ambiente ?? 'web',
          };
        } catch {
          return {
            id:        f.name.replace('.json', ''),
            nome:      f.name.replace(/-\d+\.json$/, '').replace(/-/g, ' '),
            timestamp: new Date(0).toISOString(),
            dlCount:   0,
            ga4Count:  0,
            validacao: null,
          };
        }
      })
    );

    res.json(sessions.filter(s => s.ambiente !== 'app').sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
  } catch {
    res.json([]);
  }
});

// Retorna detalhes de uma sessão
app.get('/api/sessions/:marca/:sessionId', async (req, res) => {
  const { marca, sessionId } = req.params;
  const localPath = path.join(__dirname, 'sessions', marca, `${sessionId}.json`);

  const normalizar = (s) => {
    // 1. Normaliza ga4Events raw → estruturado
    const sessaoBase = { ...s, ga4Events: normalizeGA4Events(s.ga4Events ?? []) };
    // 2. Recalcula validacao E comparacao com o validator/comparador atuais
    // (retroativo) — antes só validacao era recalculada; comparacao ficava presa
    // no que foi salvo no arquivo lá na captura original da sessão, ignorando
    // qualquer correção feita depois no validator.js (achado real: pareamento e
    // dedup de custom_/user_info corrigidos hoje não apareciam aqui por causa disso).
    try {
      const { validateAll, verificarConsistencia } = require('./validator');
      const { compareAll } = require('./ga4-comparator');
      const configPath = path.join(__dirname, 'tests', marca, 'config.json');
      const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath)) : {};
      const validacao       = validateAll(sessaoBase.dlEvents ?? [], sessaoBase.ga4Events ?? []);
      const inconsistencias = verificarConsistencia(sessaoBase.dlEvents ?? []);
      const comparacao      = compareAll(sessaoBase.dlEvents ?? [], sessaoBase.ga4Events ?? [], config.eventMap ?? {});
      return { ...sessaoBase, validacao, inconsistencias, comparacao };
    } catch { return sessaoBase; }
  };

  if (fs.existsSync(localPath)) {
    return res.json(normalizar(JSON.parse(fs.readFileSync(localPath))));
  }

  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;
  if (!token || !repo) return res.status(404).json({ error: 'Sessao nao encontrada' });

  try {
    const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
    const branch  = process.env.GITHUB_BRANCH ?? 'main';
    const metaResp = await fetch(`https://api.github.com/repos/${repo}/contents/sessions/${marca}/${sessionId}.json?ref=${branch}`, { headers });

    if (metaResp.ok) {
      const meta = await metaResp.json();
      // Arquivo <= 1MB — conteudo na resposta
      if (meta.content) {
        return res.json(normalizar(JSON.parse(Buffer.from(meta.content, 'base64').toString())));
      }
      // Arquivo > 1MB — usa download_url
      if (meta.download_url) {
        const dlResp = await fetch(meta.download_url, { headers });
        if (!dlResp.ok) return res.status(404).json({ error: 'Sessao nao encontrada' });
        return res.json(normalizar(await dlResp.json()));
      }
    }
    return res.status(404).json({ error: 'Sessao nao encontrada' });
  } catch (e) {
    console.error('session detail error:', e.message);
    res.status(500).json({ error: 'Erro ao buscar sessao: ' + e.message });
  }
});


// Exclui sessão
app.delete('/api/sessions/:marca/:sessionId', async (req, res) => {
  const { marca, sessionId } = req.params;
  const localPath = path.join(__dirname, 'sessions', marca, `${sessionId}.json`);
  if (fs.existsSync(localPath)) fs.unlinkSync(localPath);

  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;
  if (token && repo) {
    try {
      const githubPath = `sessions/${marca}/${sessionId}.json`;
      const baseUrl = `https://api.github.com/repos/${repo}/contents/${githubPath}`;
      const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests', 'Content-Type': 'application/json' };
      const getResp = await fetch(baseUrl, { headers });
      if (getResp.ok) {
        const data = await getResp.json();
        await fetch(baseUrl, { method: 'DELETE', headers, body: JSON.stringify({ message: `chore: remove sessão ${sessionId}`, sha: data.sha, branch: process.env.GITHUB_BRANCH || 'main' }) });
      }
    } catch {}
  }
  res.json({ success: true });
});
// ─── VERSÃO DA EXTENSÃO ───────────────────────────────────────────────────────
// Atualizar VERSAO_ATUAL sempre que a extensão for modificada
const VERSAO_EXTENSAO = '14.7';
const VERSAO_NOTAS = {
  '14.0': [
    'Captura de GA4 via google_tag_manager mb.listen (mais confiável)',
    'Fix de duplicação de eventos no dataLayer',
    'Novo modo de gravação de fluxos reutilizáveis',
    'Interface renovada com abas Sessão e Gravar Fluxo',
  ],
  '14.2': [
    'Captura ao vivo no Faro Web: acompanhe os disparos do dataLayer em tempo real direto no dashboard, sem precisar do Tag Assistant',
  ],
  '14.3': [
    'Fix: captura ao vivo estava mandando mensagem pra toda aba aberta no navegador a cada disparo, sobrecarregando a extensão e causando instabilidade em sessões gravadas — agora só avisa a aba do dashboard',
  ],
  '14.4': [
    'Fix: dashboard repete o pedido de status da captura ao vivo automaticamente se a extensão não responder de primeira (evita banner que não aparece mesmo com captura ativa)',
  ],
  '14.5': [
    'Fix: dashboard agora se re-registra a cada 5s pra captura ao vivo — o service worker da extensão é desligado pelo Chrome após inatividade e esquecia quem estava com o dashboard aberto, deixando o banner sem aparecer mesmo com captura ativa',
  ],
  '14.6': [
    'Fix: com o Preview do GTM ativo, um hit "de mentira" (lido direto do dataLayer, sem passar pelo caminho real configurado na tag) podia sobrescrever campo do hit real de GA4 — agora o hit real sempre tem prioridade, o Preview só complementa o que o hit real não trouxer',
  ],
  '14.7': [
    'Fix: o Preview do GTM ainda podia "emprestar" pro hit de GA4 um campo que a tag real nunca envia (ex.: line_items aparecendo como enviado pro GA4 quando a tag no GTM não mapeia esse parâmetro) — agora só uma lista fixa de campos confirmados (ex.: search_found) pode ser complementada pelo Preview; qualquer outro campo exclusivo do Preview é descartado, nunca incorporado no hit final',
  ],
};

app.get('/api/extensao/versao', (req, res) => {
  res.json({
    versao:       VERSAO_EXTENSAO,
    notas:        VERSAO_NOTAS[VERSAO_EXTENSAO] ?? [],
    downloadUrl:  '/api/download-extensao',
    atualizadoEm: '2026-05-22',
  });
});
app.get('/api/download-extensao', async (req, res) => {
  const zipPath = path.join(__dirname, 'extensao-v2.zip');

  // Se o ZIP já existe, serve direto
  if (fs.existsSync(zipPath)) {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="faro-extensao.zip"');
    return fs.createReadStream(zipPath).pipe(res);
  }

  // Gera o ZIP dinamicamente a partir da pasta extensao-v2
  const extensaoDir = path.join(__dirname, 'extensao-v2');
  if (!fs.existsSync(extensaoDir)) {
    return res.status(404).json({ error: 'Extensão não encontrada no servidor' });
  }

  try {
    // archiver@8 reescreveu a API pra ESM com classes (ZipArchive/TarArchive/...) —
    // não é mais a função chamável "archiver('zip', opts)" das versões 7.x e anteriores.
    // Confirmado direto na versão travada pelo package-lock.json (8.0.0).
    const { ZipArchive } = require('archiver');
    const archive = new ZipArchive({ zlib: { level: 9 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="faro-extensao.zip"');
    archive.pipe(res);
    // destpath=false zipa o conteúdo direto na raiz do ZIP (sem pasta embrulhando) — é
    // o formato certo pra "Carregar sem compactação" no Chrome, sem precisar navegar
    // em subpasta. "faro-extensao" como destpath não estava funcionando no archiver@8
    // (a raiz do ZIP saía com o nome da pasta de origem, não o destpath pedido).
    archive.directory(extensaoDir, false);
    await archive.finalize();
  } catch (e) {
    res.status(500).json({ error: 'Erro ao gerar ZIP: ' + e.message });
  }
});
app.post('/api/save-flow', async (req, res) => {
  const { nome, marca, sgtmDomain, startUrl, actions, dlEvents, ga4Events, parceiros } = req.body;
  if (!nome || !marca) return res.status(400).json({ error: 'nome e marca obrigatórios' });

  const flowId    = nome.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now();
  const fileName  = `${flowId}.json`;
  const filePath  = `flows/${marca}/${fileName}`;
  const flowData  = {
    id: flowId, nome, marca, sgtmDomain, startUrl,
    createdAt: new Date().toISOString(),
    actions:   actions    ?? [],
    // Snapshot dos eventos na gravação original (referência)
    dlSnapshot:       dlEvents  ?? [],
    ga4Snapshot:      ga4Events ?? [],
    parceirosSnapshot: parceiros ?? [],
  };

  fs.mkdirSync(path.join(__dirname, 'flows', marca), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'flows', marca, fileName), JSON.stringify(flowData, null, 2));

  try {
    await commitToGitHub(filePath, JSON.stringify(flowData, null, 2), `flow: ${nome} (${marca})`);
  } catch (e) { console.error('Flow commit erro:', e.message); }

  res.json({ success: true, flowId });
});

// ─── LISTA FLUXOS GRAVADOS DE UMA MARCA ──────────────────────────────────────

// ─── LOG DE EXECUÇÃO DE FLUXO ────────────────────────────────────────────────
app.get('/api/flows/log/:marca/:flowId', (req, res) => {
  const key   = `${req.params.marca}/${req.params.flowId}`;
  const entry = flowLogsStore.get(key);
  if (!entry) return res.json({ logs: [], status: 'not_found' });
  res.json({ logs: entry.logs, timestamp: entry.timestamp, status: entry.status ?? 'running' });
});

app.get('/api/flows/:marca', async (req, res) => {
  const { marca } = req.params;
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH ?? 'main';
  const flowsMap = {}; // id → flow (dedup)

  // Lê do GitHub primeiro (fonte de verdade)
  try {
    const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
    const resp = await fetch(`https://api.github.com/repos/${repo}/contents/flows/${marca}?ref=${branch}`, { headers });
    if (resp.ok) {
      const files = await resp.json();
      await Promise.all(
        files.filter(f => f.name.endsWith('.json')).map(async f => {
          try {
            const dr   = await fetch(f.download_url, { headers });
            const data = await dr.json();
            flowsMap[data.id] = { id: data.id, nome: data.nome, createdAt: data.createdAt, actionCount: data.actions?.length ?? 0 };
          } catch {}
        })
      );
    }
  } catch {}

  // Mescla com arquivos locais (recém salvos, ainda não commitados)
  const localDir = path.join(__dirname, 'flows', marca);
  if (fs.existsSync(localDir)) {
    fs.readdirSync(localDir).filter(f => f.endsWith('.json')).forEach(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(localDir, f)));
        flowsMap[data.id] = { id: data.id, nome: data.nome, createdAt: data.createdAt, actionCount: data.actions?.length ?? 0 };
      } catch {}
    });
  }

  const flows = Object.values(flowsMap).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  res.json(flows);
});

// ─── EXECUTA FLUXO VIA PLAYWRIGHT ────────────────────────────────────────────
// ── Logs da última execução ───────────────────────────────────────────────
app.get('/api/flow-logs/:marca/:flowId', (req, res) => {
  const key = `${req.params.marca}/${req.params.flowId}`;
  const entry = flowLogsStore.get(key);
  if (!entry) return res.json({ logs: [], message: 'Nenhuma execução encontrada' });
  res.json({ logs: entry.logs, timestamp: new Date(entry.timestamp).toISOString() });
});

app.post('/api/run-flow/:marca/:flowId', async (req, res) => {
  const { marca, flowId } = req.params;

  // Carrega fluxo
  let flowData;
  const localPath = path.join(__dirname, 'flows', marca, `${flowId}.json`);
  if (fs.existsSync(localPath)) {
    flowData = JSON.parse(fs.readFileSync(localPath));
  } else {
    const token  = process.env.GITHUB_TOKEN;
    const repo   = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH ?? 'main';
    const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
    const resp = await fetch(`https://api.github.com/repos/${repo}/contents/flows/${marca}/${flowId}.json?ref=${branch}`, { headers });
    if (!resp.ok) return res.status(404).json({ error: 'Fluxo não encontrado' });
    const file = await resp.json();
    flowData = JSON.parse(Buffer.from(file.content, 'base64').toString());
  }

  const logKey = `${marca}/${flowId}`;
  flowLogsStore.set(logKey, { logs: [], timestamp: Date.now() });
  flowLog(logKey, `▶ run-flow: ${flowData.nome} (${marca}) | ${flowData.actions?.length} ações | startUrl: ${flowData.startUrl}`);

  try {
    // Executa de forma SÍNCRONA — responde só quando terminar
    const resultado = await executarFluxo(flowData, marca, logKey);
    console.log(`✅ run-flow concluído: ${resultado.dlCount} DL, ${resultado.ga4Count} GA4, sessão: ${resultado.sessionId}`);
    const logEntry = flowLogsStore.get(logKey);
    if (logEntry) logEntry.status = 'done';
    res.json({ success: true, flowId, ...resultado });
  } catch (e) {
    console.error(`❌ run-flow erro: ${e.message}\n${e.stack?.slice(0, 500)}`);
    flowLog(logKey, `❌ ERRO: ${e.message}`);
    const logEntry = flowLogsStore.get(logKey);
    if (logEntry) logEntry.status = 'error';
    res.status(500).json({ error: e.message });
  }
});

async function executarFluxo(flowData, marca, logKey = 'debug') {
  const { chromium } = require('@playwright/test');
  const dlEvents  = [];
  const ga4Events = [];

  // Função para coletar e limpar eventos acumulados na página
  async function coletarEventos(page) {
    try {
      const captured = await page.evaluate(() => {
        const items = window.__playwrightDL ?? [];
        window.__playwrightDL = []; // limpa após coletar
        return items;
      });
      captured.forEach(item => {
        if (item._ga4) ga4Events.push({ event: item.event, timestamp: item.timestamp });
        else dlEvents.push(item);
      });
      if (captured.length > 0) flowLog(logKey, `    → coletados ${captured.length} eventos (total: DL=${dlEvents.length} GA4=${ga4Events.length})`);
    } catch {}
  }

  flowLog(logKey, `  → Iniciando Playwright headless`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    channel: undefined, // usa Chromium do Playwright
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    // Habilita eventos de mouse para hover funcionar
    hasTouch: false,
  });
  const page    = await context.newPage();

  // Injeta captura — persiste entre navegações via addInitScript
  await context.addInitScript(() => {
    if (window.__playwrightDL === undefined) window.__playwrightDL = [];
    window.dataLayer = window.dataLayer || [];
    const orig = window.dataLayer.push.bind(window.dataLayer);
    window.dataLayer.push = function(...args) {
      args.forEach(ev => { if (ev?.event) window.__playwrightDL.push({ event: ev, timestamp: Date.now(), url: window.location.href }); });
      return orig(...args);
    };
    const tryListen = () => {
      const mb = window.google_tag_manager?.mb;
      if (mb?.listen) {
        mb.listen(msg => {
          const raw = msg?.message ?? msg;
          if (raw?.[0] === 'event' && raw?.[1]) {
            window.__playwrightDL.push({ _ga4: true, event: { event_name: raw[1], params: raw[2] }, timestamp: Date.now() });
          }
        });
        return true;
      }
      return false;
    };
    if (!tryListen()) {
      let t = 0;
      const iv = setInterval(() => { t++; if (tryListen() || t > 30) clearInterval(iv); }, 300);
    }
  });

  // Coleta eventos quando a página começa a descarregar (antes de navegar)
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) {
      await coletarEventos(page).catch(() => {});
    }
  });

  try {
    if (flowData.startUrl) {
      flowLog(logKey, `  → goto: ${flowData.startUrl}`);
      await page.goto(flowData.startUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1500); // aguarda GTM + mb.listen
    }

    // Filtra phantoms: (0,0) desconhecido e duplicatas rápidas de label+input
    const acoesFiltradas = (flowData.actions ?? []).filter((action, idx, arr) => {
      if (action.type !== 'click') return true;
      // Remove phantoms
      if (action.x === 0 && action.y === 0 && !action.href && !action.cssSelector) return false;
      // Remove duplicatas: mesmo href ou mesmas coords em < 250ms
      const prev = arr[idx - 1];
      if (prev && prev.type === 'click' && action.url === prev.url) {
        const diff = Math.abs((action.timestamp ?? 0) - (prev.timestamp ?? 0));
        if (diff < 250) {
          const sameHref   = action.href && action.href === prev.href;
          const sameCoords = Math.abs((action.x ?? 0) - (prev.x ?? 0)) < 2 && Math.abs((action.y ?? 0) - (prev.y ?? 0)) < 2;
          if (sameHref || sameCoords) return false;
        }
      }
      return true;
    });
    flowLog(logKey, `  → ${acoesFiltradas.length} acoes validas (${(flowData.actions ?? []).length - acoesFiltradas.length} fantasmas removidas)`);
    for (const [idx, action] of acoesFiltradas.entries()) {
      flowLog(logKey, `  -> step ${idx + 1}/${acoesFiltradas.length}: ${action.type} ${action.href ?? action.text ?? action.url ?? '(' + action.x + '%,' + action.y + '%)' } [${action.clickTipo ?? ''}]`);

      if (action.type === 'navigation') {
        // Coleta antes de navegar
        await coletarEventos(page);
        await page.goto(action.url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);
        continue;
      }

      if (action.type === 'scroll') {
        await page.evaluate(pct => window.scrollTo(0, document.body.scrollHeight * pct / 100), action.y);
        await page.waitForTimeout(800);
        await coletarEventos(page);
        continue;
      }

      if (action.type === 'click') {
        let clicked = false;
        const temTexto = action.text && action.text.trim().length > 0 && action.text !== 'undefined';

        // ── Estratégia 0: _selectors[] do CDP — múltiplos seletores em ordem de prioridade
        // Prioridade: tamanho > carrinho > testid > id > aria > texto > link (link é último recurso)
        if (!clicked && action._selectors?.length > 0) {
          const ordemTipos = ['tamanho','carrinho','sku','testid','id','aria-label','aria','dropdown','texto','link'];
          const seletoresOrdenados = [...action._selectors].sort((a, b) => {
            const ia = ordemTipos.indexOf(a.tipo ?? 'link');
            const ib = ordemTipos.indexOf(b.tipo ?? 'link');
            return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
          });

          for (const s of seletoresOrdenados) {
            if (clicked) break;
            if (!s.sel && !s.text && !s.href) continue;
            if (s.tipo === 'link') continue; // href vai no fallback abaixo
            if (s.tipo === 'aria' && s.sel && s.sel.length > 60) continue; // aria longo = inútil

            try {
              // carrinho, tamanho, sku: usa force:true — o elemento existe no DOM
              // mas fica display:none sem hover CSS. force:true ignora isso.
              const forceClick = ['carrinho','tamanho','sku'].includes(s.tipo);
              let loc;

              if (s.tipo === 'aria' && s.sel?.startsWith('aria/')) {
                const parts = s.sel.replace('aria/', '').split('/');
                const name  = parts.slice(1).join('/').trim();
                if (!name || name.length > 40) continue;
                loc = page.getByRole(parts[0], { name, exact: true }).first();
              } else if (s.tipo === 'texto' && s.text) {
                const txt = s.text.split('\n')[0].trim().slice(0, 50);
                if (!txt) continue;
                loc = page.getByText(txt, { exact: true }).first();
              } else if (s.sel) {
                loc = page.locator(s.sel).first();
              }

              if (!loc) continue;

              // Hover no card pai antes de clicar — ativa CSS :hover em qualquer site
              // Fallback: se _hoverTarget é null mas itemId existe, gera seletor automaticamente
              const hoverSel = action._hoverTarget
                || (s.itemId ? `:has(button[data-item-id="${s.itemId}"])` : null);
              if (forceClick && hoverSel) {
                try {
                  await page.hover(hoverSel, { timeout: 2000 });
                  await page.waitForTimeout(400);
                } catch {}
              }

              if (forceClick) {
                await loc.click({ force: true, timeout: 3000 });
              } else {
                await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
                await loc.click({ timeout: 4000 });
              }

              await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
              await page.waitForTimeout(1500);
              await coletarEventos(page);
              clicked = true;
              flowLog(logKey, `    ✓ clicou [${s.tipo}]${forceClick ? ' (force)' : ''}: "${(s.sel || s.text || '').slice(0, 60)}"`);
            } catch (e) {
              flowLog(logKey, `    · [${s.tipo}] falhou: ${e.message?.slice(0, 60)}`);
            }
          }

          // Fallback: href se nenhum seletor funcionou
          if (!clicked) {
            const linkSel = seletoresOrdenados.find(s => s.tipo === 'link' && s.href);
            if (linkSel) {
              try {
                await coletarEventos(page);
                await page.goto(linkSel.href, { waitUntil: 'networkidle', timeout: 15000 });
                await page.waitForTimeout(1500);
                await coletarEventos(page);
                clicked = true;
                flowLog(logKey, `    ✓ fallback href: "${linkSel.href.slice(0, 60)}"`);
              } catch (e) { flowLog(logKey, `    ✗ href falhou: ${e.message?.slice(0,60)}`); }
            }
          }

          if (!clicked) flowLog(logKey, `    ✗ todos os seletores CDP falharam`);
        }

        // ── Estratégia 0b: cssSelector simples (fallback para fluxos sem _selectors)
        if (!clicked && action.cssSelector && !action._selectors?.length) {
          try {
            const tipo = action.clickTipo ?? 'desconhecido';
            if (action.y > 0) {
              const scrollH = await page.evaluate(() => document.body.scrollHeight);
              await page.evaluate(y => window.scrollTo(0, y), Math.max(0, scrollH * action.y / 100 - 300));
              await page.waitForTimeout(500);
            }
            const loc = page.locator(action.cssSelector).first();
            await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            await loc.click({ timeout: 5000 });
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(1500);
            await coletarEventos(page);
            clicked = true;
            flowLog(logKey, `    ✓ clicou por cssSelector [${tipo}]: "${action.cssSelector}"`);
          } catch (e) { flowLog(logKey, `    ✗ cssSelector falhou: ${e.message.slice(0, 80)}`); }
        }

        // ── Estratégia 0b: data-item-id para carrinho (SKU unico por card) ────
        if (!clicked && action.clickTipo === 'carrinho' && action.dataAttrs?.['data-item-id']) {
          try {
            const itemId = action.dataAttrs['data-item-id'];
            const loc = page.locator('button[data-item-id="' + itemId + '"]').first();
            await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            await loc.click({ timeout: 5000 });
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(1500);
            await coletarEventos(page);
            clicked = true;
            flowLog(logKey, '    ✓ clicou por data-item-id [carrinho]: "' + itemId + '"');
          } catch (e) { flowLog(logKey, '    ✗ data-item-id falhou: ' + e.message.slice(0, 80)); }
        }

        // ── Estratégia 0c: href direto para links sem cssSelector ────────────
        if (!clicked && action.clickTipo === 'link' && action.href && !temTexto) {
          try {
            await coletarEventos(page);
            await page.goto(action.href, { waitUntil: 'networkidle', timeout: 15000 });
            await page.waitForTimeout(1500);
            clicked = true;
            flowLog(logKey, `    ✓ navegou por href [link]`);
          } catch (e) { flowLog(logKey, `    ✗ href [link] falhou: ${e.message.slice(0, 80)}`); }
        }

        // ── Estratégia 1: texto — fallback para fluxos sem cssSelector ────────
        if (!clicked && temTexto) {
          if (action.y > 0) {
            const scrollH = await page.evaluate(() => document.body.scrollHeight);
            await page.evaluate(y => window.scrollTo(0, y), Math.max(0, scrollH * action.y / 100 - 300));
            await page.waitForTimeout(600);
          }


          // Estratégia A: label[data-variant="true"] — tamanhos na PDC/PDP VTEX
          if (!clicked) {
            try {
              const result = await page.evaluate(({ href, text }) => {
                // Tenta primeiro dentro do card do produto pelo href
                let container = document;
                let debug = 'doc';
                if (href) {
                  const hrefPath = href.split('?')[0];
                  const anchors = Array.from(document.querySelectorAll('a[href]'));
                  const anchor = anchors.find(a => {
                    const ah = (a.getAttribute('href') ?? '');
                    return ah === hrefPath || ah.startsWith(hrefPath) || hrefPath.includes(ah.replace(/^\//, ''));
                  });
                  if (anchor) {
                    container = anchor.closest('li, article, section, div[class*="group"]') ?? document;
                    debug = 'card';
                  }
                }
                const labels = Array.from(container.querySelectorAll('label[data-variant="true"]'));
                const label = labels.find(l => l.textContent.trim() === text.trim());
                if (label) { label.click(); return { clicked: true, debug }; }
                // fallback: qualquer label na página
                const allLabels = Array.from(document.querySelectorAll('label[data-variant="true"]'));
                const anyLabel = allLabels.find(l => l.textContent.trim() === text.trim());
                if (anyLabel) { anyLabel.click(); return { clicked: true, debug: 'fallback' }; }
                return { clicked: false, debug, labelsFound: labels.length, allLabels: allLabels.length };
              }, { href: action.href, text: action.text });

              flowLog(logKey, `    → label[data-variant] debug: ${JSON.stringify(result)}`);
              if (result.clicked) {
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
                await page.waitForTimeout(1500);
                await coletarEventos(page);
                clicked = true;
                flowLog(logKey, `    ✓ clicou por label[data-variant]: "${action.text}" (${result.debug})`);
              }
            } catch (e) { flowLog(logKey, `    ✗ label[data-variant] falhou: ${e.message.slice(0,80)}`); }
          }

          // Estratégia B: button[data-variant="true"] — botão de carrinho na PDC/PDP VTEX
          if (!clicked) {
            try {
              const result = await page.evaluate(({ href, text }) => {
                let container = document;
                if (href) {
                  const hrefPath = href.split('?')[0];
                  const anchor = Array.from(document.querySelectorAll('a[href]'))
                    .find(a => { const ah = a.getAttribute('href') ?? ''; return ah === hrefPath || ah.startsWith(hrefPath) || hrefPath.includes(ah.replace(/^\//, '')); });
                  if (anchor) container = anchor.closest('li, article, section, div[class*="group"]') ?? document;
                }
                const btns = Array.from(container.querySelectorAll('button[data-variant="true"]'));
                const btn = btns.find(b => b.textContent.trim().includes(text.trim()));
                if (btn) { btn.click(); return { clicked: true }; }
                // fallback
                const anyBtn = Array.from(document.querySelectorAll('button[data-variant="true"]'))
                  .find(b => b.textContent.trim().includes(text.trim()));
                if (anyBtn) { anyBtn.click(); return { clicked: true, fallback: true }; }
                return { clicked: false, btnsFound: btns.length };
              }, { href: action.href, text: action.text });

              flowLog(logKey, `    → button[data-variant] debug: ${JSON.stringify(result)}`);
              if (result.clicked) {
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
                await page.waitForTimeout(1500);
                await coletarEventos(page);
                clicked = true;
                flowLog(logKey, `    ✓ clicou por button[data-variant]: "${action.text}"`);
              }
            } catch (e) { flowLog(logKey, `    ✗ button[data-variant] falhou: ${e.message.slice(0,80)}`); }
          }

          // Estratégia C: texto exato
          if (!clicked) {
            try {
              await page.getByText(action.text, { exact: true }).first().click({ timeout: 5000 });
              await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
              await page.waitForTimeout(1500);
              await coletarEventos(page);
              clicked = true;
              flowLog(logKey, `    ✓ clicou por texto exato: "${action.text}"`);
            } catch (_) {
              // Estratégia D: texto parcial
              try {
                await page.getByText(action.text, { exact: false }).first().click({ timeout: 5000 });
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
                await page.waitForTimeout(1500);
                await coletarEventos(page);
                clicked = true;
                flowLog(logKey, `    ✓ clicou por texto parcial: "${action.text}"`);
              } catch (e) { flowLog(logKey, `    ✗ texto falhou: ${e.message.slice(0,80)}`); }
            }
          }
        }

        // 2. Sem texto → navega por href
        if (!clicked && action.href && !temTexto) {
          try {
            await coletarEventos(page);
            await page.goto(action.href, { waitUntil: 'networkidle', timeout: 15000 });
            await page.waitForTimeout(1500);
            clicked = true;
            flowLog(logKey, `    ✓ navegou por href`);
          } catch (e) { flowLog(logKey, `    ✗ href falhou: ${e.message.slice(0,80)}`); }
        }

        // 3. aria-label útil
        if (!clicked && action.ariaLabel && !['view product'].includes(action.ariaLabel)) {
          try {
            await page.getByLabel(action.ariaLabel).first().click({ timeout: 5000 });
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(1500);
            await coletarEventos(page);
            clicked = true;
            flowLog(logKey, `    ✓ clicou por aria-label`);
          } catch (e) { flowLog(logKey, `    ✗ aria-label falhou`); }
        }

        // 4. Coordenadas (ignora 0,0)
        if (!clicked && action.x > 0 && action.y > 0) {
          try {
            const vp = page.viewportSize();
            await page.mouse.click(vp.width * action.x / 100, vp.height * action.y / 100);
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(1500);
            await coletarEventos(page);
            flowLog(logKey, `    ✓ clicou por coordenadas (${action.x}%, ${action.y}%)`);
          } catch (e) { flowLog(logKey, `    ✗ coordenadas falharam: ${e.message.slice(0,80)}`); }
        }
      }
    }

    // Coleta final
    await page.waitForTimeout(2000);
    await coletarEventos(page);
    flowLog(logKey, `  → total final: ${dlEvents.length} DL, ${ga4Events.length} GA4`);

  } finally {
    await browser.close();
  }

  // Valida e salva como sessão
  const { validateAll, verificarConsistencia } = require('./validator');
  const { compareAll } = require('./ga4-comparator');
  const configPath = path.join(__dirname, 'tests', marca, 'config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath)) : {};

  const sessao = {
    nome:            `${flowData.nome} (auto)`,
    marca,
    testador:        'Playwright automático',
    startUrl:        flowData.startUrl,
    timestamp:       new Date().toISOString(),
    dlEvents,
    ga4Events,
    validacao:       validateAll(dlEvents, ga4Events),
    inconsistencias: verificarConsistencia(dlEvents),
    comparacao:      compareAll(dlEvents, ga4Events, config.eventMap ?? {}),
    _fromFlow:       flowData.id,
  };

  const fileName    = `${flowData.id}-auto-${Date.now()}.json`;
  const filePath    = `sessions/${marca}/${fileName}`;
  const fileContent = JSON.stringify(sessao, null, 2);

  fs.mkdirSync(path.join(__dirname, 'sessions', marca), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'sessions', marca, fileName), fileContent);
  console.log(`  → sessão salva: ${fileName}`);

  try {
    await commitToGitHub(filePath, fileContent, `auto-session: ${flowData.nome} (${marca})`);
  } catch (e) { console.error('Auto-session commit erro:', e.message); }

  return {
    sessionId: fileName.replace('.json', ''),
    dlCount:   dlEvents.length,
    ga4Count:  ga4Events.length,
    erros:     sessao.validacao?.summary?.failed ?? 0,
  };
}

// ─── VALIDAR SNAPSHOT (sem Playwright, direto da gravação) ───────────────────
app.post('/api/validate-snapshot/:marca/:flowId', async (req, res) => {
  const { marca, flowId } = req.params;

  // Carrega fluxo
  let flowData;
  const localPath = path.join(__dirname, 'flows', marca, `${flowId}.json`);
  if (fs.existsSync(localPath)) {
    flowData = JSON.parse(fs.readFileSync(localPath));
  } else {
    const token  = process.env.GITHUB_TOKEN;
    const repo   = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH ?? 'main';
    const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
    const resp = await fetch(`https://api.github.com/repos/${repo}/contents/flows/${marca}/${flowId}.json?ref=${branch}`, { headers });
    if (!resp.ok) return res.status(404).json({ error: 'Fluxo não encontrado' });
    const file = await resp.json();
    flowData = JSON.parse(Buffer.from(file.content, 'base64').toString());
  }

  const dlEvents  = flowData.dlSnapshot  ?? [];
  const ga4Events = flowData.ga4Snapshot ?? [];
  if (!dlEvents.length) return res.status(400).json({ error: 'Fluxo sem dlSnapshot — grave novamente' });

  // Usa as mesmas funções do executarFluxo
  const { validateAll, verificarConsistencia } = require('./validator');
  const { compareAll } = require('./ga4-comparator');
  const configPath = path.join(__dirname, 'tests', marca, 'config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath)) : {};

  const validacao       = validateAll(dlEvents, ga4Events);
  const inconsistencias = verificarConsistencia(dlEvents);
  const comparacao      = compareAll(dlEvents, ga4Events, config.eventMap ?? {});

  const sessao = {
    nome:          `${flowData.nome} (snapshot)`,
    marca,
    testador:      'Snapshot direto',
    startUrl:      flowData.startUrl,
    timestamp:     new Date().toISOString(),
    dlEvents,
    ga4Events,
    validacao,
    comparacao,
    inconsistencias,
    _fromFlow:     flowId,
    _modo:         'snapshot',
  };

  fs.mkdirSync(path.join(__dirname, 'sessions', marca), { recursive: true });
  const sessionId   = `${flowId}-snapshot-${Date.now()}`;
  const sessionPath = path.join(__dirname, 'sessions', marca, `${sessionId}.json`);
  const sessionContent = JSON.stringify(sessao, null, 2);
  fs.writeFileSync(sessionPath, sessionContent);

  try {
    await commitToGitHub(`sessions/${marca}/${sessionId}.json`, sessionContent, `snapshot: ${flowData.nome} (${marca})`);
  } catch (e) { console.error('Snapshot commit erro:', e.message); }

  res.json({
    success: true,
    sessionId,
    dlCount:  dlEvents.length,
    ga4Count: ga4Events.length,
    erros:    validacao?.summary?.failed ?? 0,
    _modo:    'snapshot',
  });
});

// ─── IMPORTAR CHROME DEVTOOLS RECORDER + EXECUTAR ────────────────────────────
app.post('/api/run-recorder/:marca', async (req, res) => {
  const { marca } = req.params;
  const { recording, nome, sgtmDomain } = req.body;
  if (!recording?.steps) return res.status(400).json({ error: 'JSON do Chrome Recorder inválido' });

  // Converte steps do Chrome Recorder para nosso formato de flow
  function recorderParaFlow(recording) {
    const actions = [];
    for (const step of recording.steps ?? []) {
      if (step.type === 'navigate') {
        actions.push({ type: 'navigation', url: step.url, timestamp: Date.now() });
      } else if (step.type === 'click') {
        // Chrome Recorder fornece múltiplos seletores — extrai o melhor
        const sels = (step.selectors ?? []).flat();
        const css   = sels.find(s => !s.startsWith('aria/') && !s.startsWith('xpath/') && !s.startsWith('pierce/') && !s.startsWith('text/'));
        const aria  = sels.find(s => s.startsWith('aria/'));
        const text  = sels.find(s => s.startsWith('text/'));
        actions.push({
          type:        'click',
          timestamp:   Date.now(),
          url:         step.target ?? '',
          cssSelector: css ?? null,
          ariaLabel:   aria ? aria.replace('aria/', '') : null,
          text:        text ? text.replace('text/', '') : null,
          clickTipo:   css?.includes('[data-cart-item]') ? 'carrinho' :
                       css?.includes('label[for') ? 'tamanho' : 'link',
          _fromRecorder: true,
          _selectors:  sels,
          x: 0, y: 0,
        });
      } else if (step.type === 'scroll') {
        const pageH = step.y ?? 0;
        actions.push({ type: 'scroll', y: pageH > 0 ? 50 : 0, timestamp: Date.now() });
      } else if (step.type === 'change') {
        const sels = (step.selectors ?? []).flat();
        const sel  = sels.find(s => !s.startsWith('aria/') && !s.startsWith('xpath/'));
        actions.push({ type: 'type', value: step.value, selector: sel ?? 'input', timestamp: Date.now() });
      }
    }
    return actions;
  }

  const flowNome  = nome ?? recording.title ?? 'recorder-import';
  const flowId    = flowNome.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now();
  const startUrl  = recording.steps?.find(s => s.type === 'navigate')?.url ?? '';
  const actions   = recorderParaFlow(recording);

  const flowData  = {
    id: flowId, nome: flowNome, marca, sgtmDomain: sgtmDomain ?? '',
    startUrl, createdAt: new Date().toISOString(),
    actions, dlSnapshot: [], ga4Snapshot: [],
    _fromRecorder: true,
  };

  fs.mkdirSync(path.join(__dirname, 'flows', marca), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'flows', marca, `${flowId}.json`), JSON.stringify(flowData, null, 2));

  const logKey = `${marca}/${flowId}`;
  flowLogsStore.set(logKey, { logs: [], timestamp: Date.now() });
  flowLog(logKey, `▶ run-recorder: ${flowNome} (${marca}) | ${actions.length} steps | startUrl: ${startUrl}`);

  try {
    const resultado = await executarFluxoRecorder(flowData, marca, logKey);
    res.json({ success: true, flowId, ...resultado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Executa um fluxo originário do Chrome Recorder — usa seletores múltiplos em ordem de prioridade
async function executarFluxoRecorder(flowData, marca, logKey) {
  const { chromium } = require('@playwright/test');
  const dlEvents  = [];
  const ga4Events = [];

  async function coletarEventos(page) {
    try {
      const captured = await page.evaluate(() => {
        const items = window.__playwrightDL ?? [];
        window.__playwrightDL = [];
        return items;
      });
      captured.forEach(ev => {
        const url = page.url();
        dlEvents.push({ event: ev, timestamp: Date.now(), url });
      });
    } catch {}
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'pt-BR' });

  context.on('request', req => {
    if (flowData.sgtmDomain && req.url().includes(flowData.sgtmDomain)) {
      try {
        const parsed = parseGA4Hit(req.url());
        if (parsed?.event_name) {
          const key = parsed.event_name + '::' + (parsed.timestamp ?? Date.now());
          ga4Events.push({ event: parsed, timestamp: Date.now(), url: req.url() });
        }
      } catch {}
    }
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__playwrightDL = [];
    const push = window.dataLayer?.push?.bind(window.dataLayer);
    const observer = new MutationObserver(() => {
      if (!window.dataLayer) return;
      if (!window.dataLayer.__hooked) {
        const orig = window.dataLayer.push.bind(window.dataLayer);
        window.dataLayer.push = function(...args) {
          args.forEach(e => { if (e?.event) window.__playwrightDL.push(e); });
          return orig(...args);
        };
        window.dataLayer.__hooked = true;
        window.dataLayer.forEach(e => { if (e?.event) window.__playwrightDL.push(e); });
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });

  await page.goto(flowData.startUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await coletarEventos(page);

  for (const [idx, action] of flowData.actions.entries()) {
    flowLog(logKey, `  → step ${idx + 1}/${flowData.actions.length}: ${action.type} [${action.clickTipo ?? ''}]`);

    if (action.type === 'navigation') {
      await coletarEventos(page);
      await page.goto(action.url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await coletarEventos(page);
      continue;
    }

    if (action.type === 'scroll') {
      const scrollH = await page.evaluate(() => document.body.scrollHeight);
      await page.evaluate(y => window.scrollTo(0, y), scrollH * (action.y ?? 50) / 100);
      await page.waitForTimeout(600);
      continue;
    }

    if (action.type === 'type') {
      try {
        await page.locator(action.selector).first().fill(action.value ?? '');
        await page.waitForTimeout(300);
      } catch {}
      continue;
    }

    if (action.type === 'click') {
      let clicked = false;
      const sels = action._selectors ?? [];

      // Tenta cada seletor do Chrome Recorder em ordem de prioridade
      for (const sel of sels) {
        if (clicked) break;
        try {
          let loc;
          if (sel.startsWith('aria/')) {
            const name = sel.replace('aria/', '');
            loc = page.getByRole('button', { name }).or(page.getByRole('link', { name })).or(page.getByLabel(name)).first();
          } else if (sel.startsWith('text/')) {
            loc = page.getByText(sel.replace('text/', ''), { exact: true }).first();
          } else if (sel.startsWith('xpath/') || sel.startsWith('pierce/')) {
            loc = page.locator(sel.replace('pierce/', '')).first();
          } else {
            loc = page.locator(sel).first();
          }
          await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
          await loc.click({ timeout: 4000 });
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1500);
          await coletarEventos(page);
          clicked = true;
          flowLog(logKey, `    ✓ clicou [recorder]: "${sel.slice(0, 60)}"`);
        } catch {}
      }

      if (!clicked) flowLog(logKey, `    ✗ todos os seletores falharam`);
    }
  }

  await coletarEventos(page);
  await browser.close();

  const { validateAll, verificarConsistencia } = require('./validator');
  const { compareAll } = require('./ga4-comparator');
  const configPath2 = path.join(__dirname, 'tests', marca, 'config.json');
  const config2 = fs.existsSync(configPath2) ? JSON.parse(fs.readFileSync(configPath2)) : {};

  const validacao       = validateAll(dlEvents, ga4Events);
  const inconsistencias = verificarConsistencia(dlEvents);
  const comparacao      = compareAll(dlEvents, ga4Events, config2.eventMap ?? {});

  const sessao = {
    nome:         `${flowData.nome} (recorder)`,
    marca,
    testador:     'Chrome Recorder',
    startUrl:     flowData.startUrl,
    timestamp:    new Date().toISOString(),
    dlEvents, ga4Events, validacao, comparacao, inconsistencias,
    _fromFlow:    flowData.id,
    _modo:        'recorder',
  };

  fs.mkdirSync(path.join(__dirname, 'sessions', marca), { recursive: true });
  const sessionId      = `${flowData.id}-recorder-${Date.now()}`;
  const sessionPath    = path.join(__dirname, 'sessions', marca, `${sessionId}.json`);
  const sessionContent2 = JSON.stringify(sessao, null, 2);
  fs.writeFileSync(sessionPath, sessionContent2);

  try {
    await commitToGitHub(`sessions/${marca}/${sessionId}.json`, sessionContent2, `recorder: ${flowData.nome} (${marca})`);
  } catch (e) { console.error('Recorder commit erro:', e.message); }

  flowLog(logKey, `  -> total final: ${dlEvents.length} DL, ${ga4Events.length} GA4`);
  return { sessionId, dlCount: dlEvents.length, ga4Count: ga4Events.length, erros: validacao?.summary?.failed ?? 0, _modo: 'recorder' };
}


// ─── SAÚDE DO TRACKING — agrega todas as sessões de uma marca ────────────────

// ─── OVERVIEW: SAÚDE DE TODAS AS MARCAS (baseado na sessão de saúde de cada marca) ──
function normalizarRegiaoOverview(r) {
  if (!r) return null;
  return removerAcentosGlobal(r.toLowerCase()).replace('todas as paginas', 'all').replace(/[-\s]/g, '').trim();
}
function extrairRegionEventoOverview(dl) {
  const ev  = dl.event ?? dl;
  const eco = ev.ecommerce ?? {};
  const r = eco.region ?? ev.region ?? null;
  return r ? String(r).toLowerCase().trim() : null;
}

// Calcula score de saúde de uma sessão vs schema (mesma lógica de /api/health-session)
// Normaliza ga4Events de sessão de app para o formato dl-like que os
// endpoints de saúde esperam — sem modificar nenhuma outra lógica existente.
// Para sessões web, retorna dlEvents diretamente (comportamento original).
// ─── NORMALIZAÇÃO DE GA4 EVENTS (formato raw → estruturado) ──────────────────
// A extensão captura hits GA4 via sendBeacon/fetch e armazena os params em
// formato URLSearchParams bruto (ep.*, epn.*, pr1, etc.). Esta função converte
// para o formato estruturado que o dashboard e o validador esperam.
function parseProductGA4(raw) {
  const item = {}, parts = raw.split('~');
  const customKeys = {};
  parts.forEach((p, idx) => {
    const km = p.match(/^k(\d+)(.+)$/), vm = p.match(/^v(\d+)(.+)$/);
    if (km) customKeys[`k${km[1]}`] = decodeURIComponent(km[2]);
    if (vm) customKeys[`v${vm[1]}`] = decodeURIComponent(vm[2]);
  });
  Object.keys(customKeys).filter(k => k.startsWith('k')).forEach(k => {
    const idx = k.slice(1);
    const name = customKeys[`k${idx}`], val = customKeys[`v${idx}`];
    if (name && val !== undefined) item[name] = val;
  });
  parts.forEach(p => {
    if      (p.startsWith('id')) item.item_id        = p.slice(2);
    else if (p.startsWith('nm')) item.item_name      = decodeURIComponent(p.slice(2));
    else if (p.startsWith('br')) item.item_brand     = decodeURIComponent(p.slice(2));
    else if (p.startsWith('ca')) item.item_category  = decodeURIComponent(p.slice(2));
    else if (p.startsWith('c2')) item.item_category2 = decodeURIComponent(p.slice(2));
    else if (p.startsWith('va')) item.item_variant   = decodeURIComponent(p.slice(2));
    else if (p.startsWith('pr')) item.price          = parseFloat(p.slice(2));
    else if (p.startsWith('qt')) item.quantity       = parseInt(p.slice(2));
    else if (p.startsWith('ds')) item.discount       = parseFloat(p.slice(2));
    else if (p.startsWith('ps')) item.index          = parseInt(p.slice(2));
    else if (p.startsWith('lp')) item.index          = parseInt(p.slice(2));
    else if (p.startsWith('ln')) item.item_list_name = decodeURIComponent(p.slice(2));
  });
  return Object.keys(item).length > 0 ? item : null;
}

// Detecta se um objeto params está em formato raw (tem chaves ep.*, epn.* ou pr*)
function isGA4RawParams(params) {
  if (!params || typeof params !== 'object') return false;
  return Object.keys(params).some(k => k.startsWith('ep.') || k.startsWith('epn.') || /^pr\d+$/.test(k));
}

function normalizeGA4Event(ev) {
  if (!ev) return ev;

  const inner  = (ev.event && typeof ev.event === 'object') ? ev.event : ev;
  const params = inner.params ?? ev.params ?? {};

  // Remove objeto ecommerce aninhado dentro de params — normalmente é dado do DL/GTM
  // interno que aparece em capturas de fallback (mb/preview), redundante com os params
  // de nível superior. EXCEÇÃO: quando o hit carrega dado real só dentro do ecommerce
  // aninhado (ex.: "items" raso só com ID, usado pro remarketing do Google Ads, +
  // "ecommerce.items" estruturado de verdade pro GA4 Analytics; ou "brand"/"region"/
  // "currency" que só vêm dentro do ecommerce, nunca soltos no nível de cima), promove
  // esse campo pro lugar esperado em vez de descartar — senão a cópia boa se perde e o
  // campo vira falso "ausente" na validação. Só preenche buraco: nunca sobrescreve um
  // valor que já existe no nível superior.
  if (params.ecommerce && typeof params.ecommerce === 'object') {
    const ecoItems      = Array.isArray(params.ecommerce.items) ? params.ecommerce.items : [];
    const topItems      = Array.isArray(params.items) ? params.items : [];
    const ecoTemDadoReal = ecoItems.length > 0 && typeof ecoItems[0] === 'object' && ecoItems[0] !== null;
    const topEhFraco     = topItems.length === 0 || typeof topItems[0] !== 'object' || topItems[0] === null;
    const { ecommerce, ...cleanParams } = params;
    if (ecoTemDadoReal && topEhFraco) cleanParams.items = ecoItems;
    for (const [key, val] of Object.entries(ecommerce)) {
      if (key === 'items') continue;
      if (val === undefined || val === null || val === '') continue;
      const atual = cleanParams[key];
      if (atual === undefined || atual === null || atual === '') cleanParams[key] = val;
    }
    if (inner.params) inner.params = cleanParams;
    else if (ev.params) ev.params = cleanParams;
  }

  // Se os params já estão em formato estruturado (sem ep.* ou epn.*), retorna como está
  if (!isGA4RawParams(inner.params ?? ev.params ?? {})) return ev;

  // Params em formato URLSearchParams raw (ep.*, epn.*, pr*) → normaliza
  const rawParams = inner.params ?? ev.params ?? {};
  const normalized = {};
  const items = [];
  const IGNORAR = new Set(['en','_s','_p','_et','v','tid','cid','sid','sct','seg','_ss','dt','sr','ul','uap','uapv','uam','tfd']);

  for (const [key, val] of Object.entries(rawParams)) {
    if (IGNORAR.has(key)) continue;
    if (/^gap\./.test(key) || key === 'evnid') continue;
    if (key.startsWith('ep.'))  { normalized[key.slice(3)] = val; continue; }
    if (key.startsWith('epn.')) { const n = parseFloat(val); if (!isNaN(n)) normalized[key.slice(4)] = n; continue; }
    if (/^pr(\d+)$/.test(key))  { const item = parseProductGA4(decodeURIComponent(val)); if (item) items.push(item); continue; }
    if (key === 'cu') { normalized.currency = val; continue; }
  }

  if (inner.params !== undefined) inner.params = normalized;
  else ev.params = normalized;
  if (items.length > 0) {
    if (inner !== ev) inner.items = items;
    else ev.items = items;
  }
  return ev;
}

function normalizeGA4Events(ga4Events) {
  if (!Array.isArray(ga4Events)) return ga4Events;

  const URL_IGNORAR     = ['tagassistant.google.com', 'tag-assistant'];
  const PREFIXO_IGNORAR = ['connection__'];

  // Detecta pushes UA que não geram hits GA4 reais:
  // - ecommerceV2 na raiz → push dual UA+GA4, o GA4 real dispara separado
  // - dimension* nos items → formato UA legado
  // Só filtra fontes de fallback (mb/preview) — hits de rede são sempre reais
  function isUAPush(ev) {
    const inner = (ev.event && typeof ev.event === 'object') ? ev.event : ev;
    const src   = inner._source ?? ev._source ?? '';
    if (src === 'fetch' || src === 'sendBeacon' || src.startsWith('merged')) return false;
    const params = inner.params ?? ev.params ?? {};
    if (params.ecommerceV2 || ev.ecommerceV2) return true;
    const items = params.items ?? inner.items ?? ev.items ?? [];
    if (Array.isArray(items) && items.length > 0) {
      const item0 = items[0] ?? {};
      if (Object.keys(item0).some(k => /^dimension\d+$/.test(k))) return true;
    }
    return false;
  }

  // Detecta hit de OUTRO destino (Facebook Pixel/CAPI) misturado num evento sem "send_to"
  // e com fingerprint de Facebook (fbp, user_data.*, x-fb-*) — contaminava a validação
  // com "ausente" pra campos que esse hit nunca poderia ter (achado real: sessão "saude1"
  // da marca-d, view_item reportando item_ref/currency ausente por causa disso).
  //
  // EXCEÇÃO: hits com _source "fetch"/"sendBeacon" NUNCA são tratados como Facebook, não
  // importa o fingerprint — o injector.js só captura por esse caminho quando a requisição
  // já bateu contra o domínio de GA4/sGTM (google-analytics.com/analytics.google.com/o
  // domínio de Server-Side GTM configurado pela marca); domínio do Facebook é capturado
  // por um mecanismo TOTALMENTE separado (webRequest em *.facebook.com, no
  // background.js), que nunca alimenta esse array. Em Server-Side GTM é comum o mesmo
  // request de saída levar campos de vários destinos (Facebook/Pinterest/GA4) junto,
  // sem "send_to" — o servidor resolve pra qual propriedade GA4 mandar, isso nunca
  // aparece no payload que sai do navegador. Descartar esse hit pelo fingerprint sozinho
  // apaga dado real de GA4 (achado real: auth_action/"login" da marca-i, sempre nesse
  // formato — nenhum disparo real desse checkpoint jamais teria "send_to", então o filtro
  // sem essa exceção ignoraria esse checkpoint pra sempre, não só uma vez). Pedido de
  // 19/08/2026.
  function pareceHitFacebook(ev) {
    const inner  = (ev.event && typeof ev.event === 'object') ? ev.event : ev;
    const source = inner._source ?? ev._source ?? '';
    if (source === 'fetch' || source === 'sendBeacon') return false;
    const params = inner.params ?? ev.params ?? {};
    if (params.send_to) return false;
    return Object.keys(params).some(k => k.startsWith('x-fb-') || k === 'fbp' || k.startsWith('user_data'));
  }

  return ga4Events
    .filter(ev => {
      const url   = ev.url ?? ev.event?.url ?? '';
      const inner = (ev.event && typeof ev.event === 'object') ? ev.event : ev;
      const nome  = inner.event_name ?? ev.event_name ?? '';
      if (URL_IGNORAR.some(d => url.includes(d))) return false;
      if (PREFIXO_IGNORAR.some(p => nome.startsWith(p))) return false;
      if (isUAPush(ev)) return false;
      if (pareceHitFacebook(ev)) return false;
      return true;
    })
    .map(normalizeGA4Event);
}

function resolverDlEvents(sessao) {
  // Usa ga4Events para TODAS as sessões — reflete o que efetivamente chegou no GA4,
  // evitando problemas de aliases custom_* e eventos que existem no DL mas não no GA4.
  const rawGA4 = sessao.ga4Events ?? [];
  const ga4Events = normalizeGA4Events(rawGA4);

  if (ga4Events.length > 0) {
    const doGA4 = ga4Events.map(ev => {
      // Web: { event: { event_name, params, items, _source }, timestamp, url }
      // App: { event_name, params, items, timestamp }
      const inner  = (ev.event && typeof ev.event === 'object') ? ev.event : ev;
      const nome   = inner.event_name ?? ev.event_name;
      if (!nome) return null;

      const params = inner.params ?? ev.params ?? {};
      const items  = inner.items ?? params.items ?? ev.items ?? [];
      const region = params.region ?? inner.region ?? ev.region ?? null;

      return {
        event: {
          event:  nome,
          region, // region ao nível do evento para extrairRegionEventoOverview
          ...params,
          ecommerce: {
            region,       // também no ecommerce para garantir leitura
            items,
            ...params,    // value, currency, etc.
          },
        },
        timestamp: ev.timestamp ?? inner.timestamp ?? Date.now(),
        // A URL vinha sendo descartada aqui. Ela é a única pista de região que sobra quando a
        // tag não manda `region` e o evento mora no checkout (ver regiaoPelaUrlGlobal).
        url:       ev.url ?? inner.url ?? null,
        _fromGA4:  true,
      };
    }).filter(Boolean);

    return completarComDataLayer(sessao, doGA4);
  }

  // Fallback para dlEvents caso ga4Events esteja vazio (sessões antigas sem ga4Events)
  return sessao.dlEvents ?? [];
}

// COMPLETAR O CONJUNTO DO GA4 COM O DATALAYER.
//
// O score de saúde lê os ga4Events (ver comentário em resolverDlEvents). Isso produzia
// "ausente no dash, presente na sessão", que é a pior leitura possível: quem abre a tela vê
// lacuna, abre a sessão e o evento está lá. Medido na Marca I em 2026-10-27, as ausências
// falsas tinham três causas distintas:
//
//   1. O GA4 não capturou NENHUM hit do evento. O checkout mora em `secure.<marca>`, outro
//      documento — begin_checkout, add_payment_info, add_shipping_info, order_reviewed e
//      add_personal_info disparam no dataLayer e nunca aparecem nos ga4Events.
//   2. O GA4 capturou, mas em OUTRA região. remove_from_cart e view_cart têm hit de Mini-cart
//      e nenhum de Checkout; select_item e search_zipcode têm hit de todas as regiões menos
//      Mini-cart. O dataLayer traz a região que falta, nomeada.
//   3. O GA4 capturou SEM `region` porque a tag não envia o campo (view_item na PDP: 10 hits,
//      zero com região). Esse caso NÃO se resolve aqui — quem resolve é a regra de região única
//      do schema, dentro do matching de ocorrências.
//
// Decisão do usuário em 2026-10-27: a entrega ao GA4 é assunto do dash de DETALHAMENTO, que já
// cuida de hit que não chegou. O dash de saúde mede IMPLEMENTAÇÃO.
//
// A complementação é ADITIVA e por par evento+região: nada que veio do GA4 é descartado, e só
// entra do dataLayer o que o GA4 não cobre. Era por isso que a versão anterior desta função
// (um Set de dois nomes que SUBSTITUÍA os hits do GA4) não escalava — para cada novo evento
// era preciso nomear o evento e aceitar perder o hit real.
function completarComDataLayer(sessao, doGA4) {
  const dl = sessao.dlEvents ?? [];
  if (!dl.length) return doGA4;

  const nomeDe = (e) => { const ev = e.event ?? e; return String(ev.event ?? ev.event_name ?? ''); };
  const semPrefixo = (n) => n.replace(/^custom_/, '');
  // Região EFETIVA: a do payload e, quando ela não existe, a que a URL do checkout denuncia.
  // Sem esse segundo passo o disparo sem região nunca entra pela causa 2, porque a chave
  // evento+região fica vazia e é descartada — era o caso do add_to_cart do checkout da
  // Marca H, que dispara sem `region` e sem o prefixo custom_.
  // Região COMO O PAYLOAD INFORMA. Usada para montar o retrato do que o GA4 trouxe.
  const regiaoDe = (e) => {
    const ev  = e.event ?? e;
    const eco = ev.ecommerce ?? {};
    const r = eco.region ?? ev.region ?? null;
    return r ? String(r).toLowerCase().trim() : '';
  };

  // Região EFETIVA do candidato do dataLayer: a do payload e, só na falta dela, a que a URL
  // denuncia. Fica restrita a este lado de propósito — ver o comentário acima da função.
  const regiaoDoCandidato = (e) => regiaoDe(e) || (regiaoPelaUrlGlobal(e) ?? '');

  const nomesNoGA4     = new Set();  // o GA4 viu este evento alguma vez
  const paresNoGA4     = new Set();  // ...e nesta região
  const semRegiaoNoGA4 = new Set();  // ...e algum hit dele veio sem região
  for (const e of doGA4) {
    const n = semPrefixo(nomeDe(e));
    if (!n) continue;
    const r = regiaoDe(e);
    nomesNoGA4.add(n);
    paresNoGA4.add(`${n}::${r}`);
    if (!r) semRegiaoNoGA4.add(n);
  }

  const extras = dl.filter(e => {
    const n = semPrefixo(nomeDe(e));
    if (!n) return false;

    // Causa 1 — o GA4 não tem nada deste evento. Vem tudo do dataLayer.
    if (!nomesNoGA4.has(n)) return true;

    // Causa 3 — o GA4 tem hit sem região para este evento, então a região que ele informa não
    // é confiável e completar por região duplicaria a MESMA jornada (o hit sem região e o
    // disparo do DL com região são o mesmo clique). Fica para a regra de região única.
    if (semRegiaoNoGA4.has(n)) return false;

    // Causa 2 — o GA4 informa região para este evento, mas não esta.
    const r = regiaoDoCandidato(e);
    return r !== '' && !paresNoGA4.has(`${n}::${r}`);
  });

  return extras.length ? [...doGA4, ...extras] : doGA4;
}

// Conta quantos campos ficariam de erro pra um único disparo do evento (sem side-effects)
// — usado só pra comparar disparos duplicados do mesmo evento+região (ex.: hit de Google
// Ads + hit de GA4 Analytics pro mesmo "purchase", com destinos diferentes no mesmo GA4)
// e escolher o mais completo como referência, em vez de unir os erros de todos. Mesma regra
// de validação usada dentro de calcularScoreSessao/health-session, só sem side-effects.
function contarErrosOcorrenciaWeb(dl, schemaEv, nome, regionObrigatoria) {
  const ev  = dl.event ?? dl;
  const eco = ev.ecommerce ?? ev;
  const regionReal = eco.region ?? ev.region ?? null;
  let count = 0;
  for (const param of schemaEv.parameters ?? []) {
    const arrayMatch = param.path && param.path.match(/^(\w+)\[\]\.(.+)$/);
    const nomePar = arrayMatch ? arrayMatch[2] : (param.path ? param.path.replace('items[].', '') : param.name);
    if (PARAMS_WEB_ONLY_GLOBAL.has(nomePar) || PARAMS_IGNORAR_SEMPRE_GLOBAL.has(nomePar)) continue;
    if (param.required === false) continue;
    if (arrayMatch) {
      const [, arrayKey] = arrayMatch;
      const arr = asArray(eco[arrayKey] ?? ev[arrayKey]);
      if (!arr.length) {
        if (!(arrayKey === 'items' && EVENTOS_SEM_ITEMS_GLOBAL.has(nome))) count++;
      } else {
        // coupon é documentado como campo do item, mas na prática a marca manda no
        // nível do pedido (ecommerce.coupon) — aceitar de onde vier.
        arr.forEach(item => { const val = item[nomePar] ?? (nomePar === 'coupon' ? (eco[nomePar] ?? ev[nomePar]) : undefined); if (val === undefined || val === null || val === '') count++; });
      }
    } else {
      if (nomePar === 'items' && EVENTOS_SEM_ITEMS_GLOBAL.has(nome)) continue;
      const items0 = (eco.items ?? ev.items ?? [])[0] ?? {};
      const val = eco[nomePar] ?? ev[nomePar] ?? items0[nomePar];
      if (val === undefined || val === null || val === '') count++;
    }
  }
  if (!regionReal && regionObrigatoria) count++;
  return count;
}

// Conta quantos campos SERIAM checados nesse disparo (mesma iteração de
// contarErrosOcorrenciaWeb, mas o denominador em vez do numerador) — usado só pra saber se
// uma ocorrência está "essencialmente vazia" na proporção certa. Sem isso, um evento com
// items[] grande (ex.: view_item_list com 15 produtos) que falta 1 campo em cada item já
// soma mais "erros" do que o total de parâmetros do schema tem entradas, disparando o
// fallback pro DL por engano mesmo com o disparo majoritariamente correto.
function contarChecksOcorrenciaWeb(dl, schemaEv, nome, regionObrigatoria) {
  const ev  = dl.event ?? dl;
  const eco = ev.ecommerce ?? ev;
  let total = 0;
  for (const param of schemaEv.parameters ?? []) {
    const arrayMatch = param.path && param.path.match(/^(\w+)\[\]\.(.+)$/);
    const nomePar = arrayMatch ? arrayMatch[2] : (param.path ? param.path.replace('items[].', '') : param.name);
    if (PARAMS_WEB_ONLY_GLOBAL.has(nomePar) || PARAMS_IGNORAR_SEMPRE_GLOBAL.has(nomePar)) continue;
    if (param.required === false) continue;
    if (arrayMatch) {
      const [, arrayKey] = arrayMatch;
      const arr = asArray(eco[arrayKey] ?? ev[arrayKey]);
      total += arr.length ? arr.length : 1;
    } else {
      if (nomePar === 'items' && EVENTOS_SEM_ITEMS_GLOBAL.has(nome)) continue;
      total += 1;
    }
  }
  return total + (regionObrigatoria ? 1 : 0);
}

// Detecta hit de tag legada/duplicada (ex.: pixel antigo tipo Universal Analytics) —
// usa os campos genéricos "dimension1/2/3" dentro dos itens em vez dos campos de
// ecommerce de verdade. Pedido da equipe: quando esse padrão aparece, o disparo deve
// ser desconsiderado e a validação deve cair pro evento "custom_..." correspondente no
// DataLayer bruto (que hoje nunca é olhado quando o GA4 não está vazio pra sessão toda).
function temDimensaoGenericaLegado(dl) {
  const ev  = dl.event ?? dl;
  const eco = ev.ecommerce ?? ev;
  const items = asArray(eco.items ?? ev.items);
  return items.some(it => it && (it.dimension1 !== undefined || it.dimension2 !== undefined || it.dimension3 !== undefined));
}

// Alguns hits reais de GA4 mandam um array serializado errado (ex.: "shippings"
// virando a string "[object Object],[object Object]" em vez de uma lista de
// verdade) — sem essa checagem, ".forEach"/".length" quebra o cálculo de saúde
// inteiro (achado real: sessão "saude1" da marca-d, evento search_zipcode).
function asArray(v) {
  return Array.isArray(v) ? v : [];
}

// Detecta evento nativo da plataforma (Vtex) disparando sem prefixo com o mesmo
// nome do evento "custom_X" da marca — não é o mesmo disparo em dois formatos,
// são dois eventos independentes que coincidem de nome (achado real: "purchase"
// nativo da Vtex no checkout do marca-f, sem "ecommerce.brand" e com só um
// subconjunto mínimo de campos, junto de um "custom_purchase" completo da marca
// na mesma sessão). Mesmo detector usado em validator.js.
function pareceEventoNativoPlataforma(dl) {
  const ev  = dl.event ?? dl;
  const eco = ev.ecommerce ?? ev;
  // Falsy, não só === undefined — achado real: "purchase" nativo da Vtex no marca-f
  // vem com brand: "" (string vazia via GA4/gtag, que sempre inclui a chave), não
  // undefined. Com o check estrito, esse hit nunca era reconhecido como nativo e o
  // "custom_purchase" de verdade (com item_ref/item_sku) nunca era usado no lugar.
  return !eco.brand && !ev.brand;
}

// Dado um conjunto de ocorrências do mesmo evento+região, devolve só a mais completa
// (menos campos faltando) — usa contarErrosOcorrenciaWeb pra comparar. Se só tiver uma
// ocorrência (o caso comum), devolve ela mesma sem nenhum cálculo extra.
function ocorrenciaMaisCompleta(ocorrencias, schemaEv, nome, regionObrigatoria) {
  if (ocorrencias.length <= 1) return ocorrencias;
  let melhor = ocorrencias[0];
  let melhorErros = contarErrosOcorrenciaWeb(melhor, schemaEv, nome, regionObrigatoria);
  for (const dl of ocorrencias.slice(1)) {
    const c = contarErrosOcorrenciaWeb(dl, schemaEv, nome, regionObrigatoria);
    if (c < melhorErros) { melhor = dl; melhorErros = c; }
  }
  return [melhor];
}

// Agrupa ocorrências pelo timestamp de disparo — hits de destino duplicado no GA4 (ex.:
// Google Ads + GA4 Analytics do MESMO clique/conversão) chegam a poucos milissegundos de
// distância um do outro; disparos genuinamente repetidos (ex.: navegar por várias páginas
// de listagem) ficam segundos/minutos afastados. Só colapsa duplicatas DENTRO da mesma
// janela de tempo — nunca entre disparos realmente distintos.
const JANELA_DUPLICATA_DESTINO_MS = 2000;
function agruparOcorrenciasPorInstante(ocorrencias) {
  const comTs = ocorrencias
    .map(dl => ({ dl, ts: (dl.event ?? dl).timestamp ?? dl.timestamp ?? null }))
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const clusters = [];
  for (const item of comTs) {
    const ultimo = clusters[clusters.length - 1];
    // Compara sempre contra o PRIMEIRO timestamp do cluster (não o último adicionado) —
    // senão uma sequência de disparos genuinamente distintos, mas rápidos (ex.: cliques
    // em vários produtos em menos de 2s cada), vai "encadeando" e grudando tudo num
    // cluster só, perdendo a contagem de erro dos disparos que ficaram de fora.
    if (ultimo && item.ts != null && ultimo.ts != null && Math.abs(item.ts - ultimo.ts) <= JANELA_DUPLICATA_DESTINO_MS) {
      ultimo.itens.push(item.dl);
    } else {
      clusters.push({ ts: item.ts, itens: [item.dl] });
    }
  }
  return clusters.map(c => c.itens);
}

// Escolhe uma ocorrência de referência POR disparo real (cluster de tempo), não uma única
// pra sessão inteira — assim um hit duplicado (Ads+Analytics) do mesmo disparo é colapsado
// num só, mas disparos genuinamente repetidos continuam TODOS contando pro union de erros
// (ex.: 10 view_item_list com 4 com erro e 6 saudáveis não pode virar "só considera 1 bom").
function ocorrenciasReferencia(ocorrencias, schemaEv, nome, regionObrigatoria) {
  if (ocorrencias.length <= 1) return ocorrencias;
  const clusters = agruparOcorrenciasPorInstante(ocorrencias);
  return clusters.map(cluster => ocorrenciaMaisCompleta(cluster, schemaEv, nome, regionObrigatoria)[0]);
}

function calcularScoreSessao(sessao, schema, modo = 'parametros') {
  // modo = 'disparos':   correto = evento disparou (independente de parâmetros)
  // modo = 'parametros': correto = evento disparou E todos os parâmetros ok (comportamento original)
  const dlEvents = resolverDlEvents(sessao);
  const marca    = sessao.marca ?? null;
  const ambiente = sessao.ambiente ?? 'web';

  // Seleciona campo de marcas conforme plataforma da sessão
  const campoMarcas = ambiente === 'app' ? 'marcas_app' : 'marcas_site';

  // Filtra apenas eventos aplicáveis à plataforma e marca desta sessão
  const eventosAplicaveisBrutos = schema.events.filter(ev => {
    const marcasPlat = ev[campoMarcas] ?? [];
    if (!marcasPlat.length) return false; // evento não existe nessa plataforma
    if (!marca) return true;
    return marcasPlat.includes(marca);
  });
  // select_content/notify_me nunca mandam region real (EVENTOS_SEM_REGIAO_REAL_GLOBAL) —
  // colapsa as N linhas de região do schema numa só por marca, em vez de manter N caixinhas
  // competindo pelos mesmos disparos ambíguos.
  const eventosAplicaveis = [];
  const jaColapsadoRegiaoOverview = new Set();
  for (const ev of eventosAplicaveisBrutos) {
    if (!EVENTOS_SEM_REGIAO_REAL_GLOBAL.has(ev.event)) { eventosAplicaveis.push(ev); continue; }
    if (jaColapsadoRegiaoOverview.has(ev.event)) continue;
    jaColapsadoRegiaoOverview.add(ev.event);
    eventosAplicaveis.push({ ...ev, regiao: 'Todas as Páginas' });
  }

  const resultado = eventosAplicaveis.map(schemaEv => {
    const nome       = schemaEv.event;
    const regiao     = schemaEv.regiao;
    const regiaoNorm = normalizarRegiaoOverview(regiao);
    const isTodas    = regiaoNorm === 'all' || regiaoNorm === 'todasaspaginas';
    const temRegiaoRealNaSessao = algumDisparoComRegiaoGlobal(dlEvents, nome, extrairRegionEventoOverview);

    // REGIÃO ÚNICA NO SCHEMA — disparo sem `region` conta para ela.
    //
    // Quando o schema declara o evento em UMA só região para esta marca, não há ambiguidade:
    // o disparo só pode ser dela. Exigir o campo `region` aí transforma defeito de TAG em
    // lacuna de IMPLEMENTAÇÃO — foi o que acontecia com view_item na PDP da Marca I (10
    // hits no GA4, nenhum com region, os 10 descartados).
    //
    // A condição antiga (`!temRegiaoRealNaSessao`) só salvava o evento que NUNCA informa
    // região em lugar nenhum. Não alcançava o caso misto: a tag manda region em parte dos
    // disparos e omite em outros, e aí os omissos eram jogados fora mesmo com uma região só
    // possível.
    const regiaoUnicaNoSchema = eventosAplicaveis.filter(e => e.event === nome).length === 1;

    const ocorrencias = dlEvents.filter(dl => {
      const ev = dl.event ?? dl;
      const evNome = ev.event ?? ev.event_name ?? '';
      const evNomeNorm = evNome.startsWith('custom_') ? evNome.replace('custom_', '') : evNome;
      const nomeMatch = (evNome === nome) || (evNomeNorm === nome) || (`custom_${evNome}` === nome);
      if (!nomeMatch) return false;
      if (isTodas) return true;
      if (regiaoNorm) {
        const regionEvento = extrairRegionEventoOverview(dl);
        if (!regionEvento) {
          // A dedução por URL só vale POSITIVAMENTE: se ela aponta para esta região, aceita.
          // Se aponta para outra, NÃO rejeita — cai no fallback de sempre. Rejeitar aqui tirava
          // disparo que antes contava: na marca-j o begin_checkout dispara sem region fora da URL
          // de checkout e era aceito por ninguém daquele evento informar região; com a rejeição
          // ele sumiu, junto com add_payment_info, add_shipping_info e add_personal_info, mais o
          // search da Busca da marca-b. Cinco presentes viraram ausentes de uma vez.
          if (regiaoPelaUrlGlobal(dl) === regiaoNorm) return true;
          return regiaoUnicaNoSchema || !temRegiaoRealNaSessao;
        }
        return aplicarAliasRegiaoGlobal(nome, normalizarRegiaoOverview(regionEvento)) === regiaoNorm;
      }
      return true;
    });

    // Eventos em EVENTOS_IGNORAR_SEMPRE_GLOBAL (ex.: "error") ausentes são esperados —
    // não conta como checkpoint ausente, fica de fora do total. Mesma coisa pra
    // combinação marca+evento+região em EVENTOS_OPCIONAIS_POR_MARCA_REGIAO_GLOBAL (ex.:
    // view_item_list no Checkout/Mini-cart da Marca D — feature ainda não implementada).
    if (ocorrencias.length === 0) {
      if (EVENTOS_IGNORAR_SEMPRE_GLOBAL.has(nome) || ehOpcionalGlobal(marca, nome, regiao)) {
        return { evento: nome, regiao, status: 'ausente', cobertura: 0, paramsErrados: [], ignorarNoTotal: true };
      }
      return { evento: nome, regiao, status: 'ausente', cobertura: 0, paramsErrados: [] };
    }

    // Peso reduzido para o evento "error": quando ele dispara, pesa menos no
    // score geral do que os demais checkpoints (é esperado que apareça pouco).
    const peso = nome === 'error' ? 0.5 : 1;

    // Parâmetros que existem só no DL web — ausência não é erro nem ponto de atenção
    const PARAMS_WEB_ONLY = PARAMS_WEB_ONLY_GLOBAL;
    const EVENTOS_SEM_ITEMS = EVENTOS_SEM_ITEMS_GLOBAL;

    // Eventos únicos no schema (aparecem em apenas 1 região para esta marca/plataforma):
    // region ausente não é erro, pois pode ser inferida pelo schema.
    // Só exige region de verdade quando o evento declara "region" como parâmetro —
    // eventos como select_content/notify_me aparecem em várias linhas de região só
    // por organização do schema, sem nunca terem "region" como campo real do payload.
    const ocorrenciasNoSchema = eventosAplicaveis.filter(e => e.event === nome).length;
    const declaraRegionParam  = (schemaEv.parameters ?? []).some(p => p.name === 'region');
    const regionObrigatoria   = ocorrenciasNoSchema > 1 && declaraRegionParam && !EVENTOS_SEM_REGION_OBRIGATORIA_WEB.has(nome);

    // Quando o MESMO disparo (mesmo instante) dispara mais de uma vez no GA4 (ex.: hit
    // duplicado pra Google Ads + GA4 Analytics, com destinos diferentes), usa só a
    // ocorrência mais completa como referência DAQUELE instante — evita que um hit vazio
    // (Ads) contamine o resultado de um hit correto (Analytics). Disparos genuinamente
    // repetidos (ex.: 10 view_item_list em momentos diferentes da sessão) continuam TODOS
    // contando — cada instante vira sua própria referência, o union de erros abaixo roda
    // sobre todos eles normalmente. Exceção: eventos em EVENTOS_MELHOR_DISPARO_UNICO_GLOBAL
    // usam só o disparo mais completo da sessão toda como referência única.
    let ocorrenciasRef = EVENTOS_MELHOR_DISPARO_UNICO_GLOBAL.has(nome)
      ? ocorrenciaMaisCompleta(ocorrencias, schemaEv, nome, regionObrigatoria)
      : ocorrenciasReferencia(ocorrencias, schemaEv, nome, regionObrigatoria);

    function buscarCandidatoDLOverview() {
      const rawDlEvents = sessao.dlEvents ?? sessao.payload?.dlEvents ?? [];
      const candidatosDL = rawDlEvents.filter(dl => {
        const ev = dl.event ?? dl;
        const evNome = ev.event ?? ev.event_name ?? '';
        const evNomeNorm = evNome.startsWith('custom_') ? evNome.replace('custom_', '') : evNome;
        const nomeMatch = (evNome === nome) || (evNomeNorm === nome) || (`custom_${evNome}` === nome);
        if (!nomeMatch) return false;
        if (isTodas) return true;
        if (regiaoNorm) {
          const regionEvento = extrairRegionEventoOverview(dl);
          if (!regionEvento) return !temRegiaoRealNaSessao;
          return aplicarAliasRegiaoGlobal(nome, normalizarRegiaoOverview(regionEvento)) === regiaoNorm;
        }
        return true;
      });
      return candidatosDL.length ? ocorrenciaMaisCompleta(candidatosDL, schemaEv, nome, regionObrigatoria)[0] : null;
    }

    // Tag legada (dimension1/2/3) OU evento nativo da plataforma (sem "brand") pode
    // acontecer em QUALQUER um dos disparos genuínos (não é só quando é o único da
    // sessão) — checa cada referência independentemente e desconsidera o disparo do
    // GA4 em favor do "custom_..." do DataLayer, sempre que ele existir. Nenhum dos
    // dois casos é confiável, não é "pior só nesse caso".
    ocorrenciasRef = ocorrenciasRef.map(ref => {
      if (!temDimensaoGenericaLegado(ref) && !pareceEventoNativoPlataforma(ref)) return ref;
      return buscarCandidatoDLOverview() ?? ref;
    });

    // Fallback pro "essencialmente vazio" só faz sentido quando há um ÚNICO disparo real
    // na sessão (não dá pra "substituir" vários disparos genuínos por um só do DL).
    if (ocorrenciasRef.length === 1) {
      const errosRef = contarErrosOcorrenciaWeb(ocorrenciasRef[0], schemaEv, nome, regionObrigatoria);
      const totalCheckavel = Math.max(contarChecksOcorrenciaWeb(ocorrenciasRef[0], schemaEv, nome, regionObrigatoria), 1);
      if (errosRef >= totalCheckavel) {
        const melhorDL = buscarCandidatoDLOverview();
        if (melhorDL) {
          const errosDL = contarErrosOcorrenciaWeb(melhorDL, schemaEv, nome, regionObrigatoria);
          if (errosDL < errosRef) ocorrenciasRef = [melhorDL];
        }
      }
    }

    // No modo 'disparos': evento que disparou = correto, mas ainda calcula
    // erros de parâmetros para exibir como ponto de atenção no dashboard.
    if (modo === 'disparos') {
      const errosSet = new Set();
      for (const dl of ocorrenciasRef) {
        const ev  = dl.event ?? dl;
        const eco = ev.ecommerce ?? ev;
        const regionReal = eco.region ?? ev.region ?? null;
        for (const param of schemaEv.parameters ?? []) {
          // Interpreta path de array genérico "chave[].campo" — não só "items[]." (ex.:
          // "shippings[]." do search_zipcode), senão o campo nunca é achado no lugar certo.
          const arrayMatch = param.path && param.path.match(/^(\w+)\[\]\.(.+)$/);
          const nomePar = arrayMatch ? arrayMatch[2] : (param.path ? param.path.replace('items[].', '') : param.name);
          if (PARAMS_WEB_ONLY.has(nomePar) || PARAMS_IGNORAR_SEMPRE_GLOBAL.has(nomePar)) continue; // ignora params web-only / sempre-ignorados
          if (PARAMS_IGNORAR_POR_MARCA_GLOBAL[marca]?.has(nomePar)) continue; // exceção por marca
          if (param.required === false) continue; // respeita required:false do schema
          if (isEventoPrincipalGlobal(schemaEv) && !PARAMS_SAUDE_EVENTOS_PRINCIPAIS_GLOBAL.has(nomePar)) continue; // eventos principais: só os 6 campos curados
          if (arrayMatch) {
            const [, arrayKey] = arrayMatch;
            const arr = asArray(eco[arrayKey] ?? ev[arrayKey]);
            // Eventos com items[] opcional (ex.: view_promotion/select_promotion sem produto
            // vinculado): array vazio não é erro, mas se vier com dados, valida normalmente.
            // A isenção só vale pro array "items" — outros arrays (ex. shippings) continuam exigidos.
            if (!arr.length) {
              if (!(arrayKey === 'items' && EVENTOS_SEM_ITEMS.has(nome))) errosSet.add(nomePar);
            } else {
              // coupon é documentado como campo do item, mas na prática a marca manda
              // no nível do pedido (ecommerce.coupon) — aceitar de onde vier.
              arr.forEach(item => { const val = item[nomePar] ?? (nomePar === 'coupon' ? (eco[nomePar] ?? ev[nomePar]) : undefined); if (val === undefined || val === null || val === '') errosSet.add(nomePar); });
            }
          } else {
            if (nomePar === 'items' && EVENTOS_SEM_ITEMS_GLOBAL.has(nome)) continue;
            const items0 = (eco.items ?? ev.items ?? [])[0] ?? {};
            const val    = eco[nomePar] ?? ev[nomePar] ?? items0[nomePar];
            if (val === undefined || val === null || val === '') errosSet.add(nomePar);
          }
        }
        if (!regionReal && regionObrigatoria && !isEventoPrincipalGlobal(schemaEv)) errosSet.add('region');
      }
      return { evento: nome, regiao, status: 'correto', cobertura: 100, paramsErrados: [...errosSet], totalParams: contarParamsAplicaveisGlobal(schemaEv), peso, ignorarNoTotal: EVENTOS_IGNORAR_SEMPRE_GLOBAL.has(nome) };
    }

    // Modo 'parametros': valida parâmetros (comportamento original)
    const errosSet = new Set();
    for (const dl of ocorrenciasRef) {
      const ev  = dl.event ?? dl;
      const eco = ev.ecommerce ?? ev;
      const regionReal = eco.region ?? ev.region ?? null;

      for (const param of schemaEv.parameters ?? []) {
        const arrayMatch = param.path && param.path.match(/^(\w+)\[\]\.(.+)$/);
        const nomePar = arrayMatch ? arrayMatch[2] : (param.path ? param.path.replace('items[].', '') : param.name);
        if (PARAMS_WEB_ONLY.has(nomePar) || PARAMS_IGNORAR_SEMPRE_GLOBAL.has(nomePar)) continue; // ignora params web-only / sempre-ignorados
        if (PARAMS_IGNORAR_POR_MARCA_GLOBAL[marca]?.has(nomePar)) continue; // exceção por marca
        if (param.required === false) continue; // respeita required:false do schema
        if (isEventoPrincipalGlobal(schemaEv) && !PARAMS_SAUDE_EVENTOS_PRINCIPAIS_GLOBAL.has(nomePar)) continue; // eventos principais: só os 6 campos curados
        if (arrayMatch) {
          const [, arrayKey] = arrayMatch;
          const arr = asArray(eco[arrayKey] ?? ev[arrayKey]);
          // Eventos com items[] opcional (ex.: view_promotion/select_promotion sem produto
          // vinculado): array vazio não é erro, mas se vier com dados, valida normalmente.
          // A isenção só vale pro array "items" — outros arrays (ex. shippings) continuam exigidos.
          if (!arr.length) {
            if (!(arrayKey === 'items' && EVENTOS_SEM_ITEMS.has(nome))) errosSet.add(nomePar);
          } else {
            // coupon é documentado como campo do item, mas na prática a marca manda
            // no nível do pedido (ecommerce.coupon) — aceitar de onde vier.
            arr.forEach(item => { const val = item[nomePar] ?? (nomePar === 'coupon' ? (eco[nomePar] ?? ev[nomePar]) : undefined); if (val === undefined || val === null || val === '') errosSet.add(nomePar); });
          }
        } else {
          const items0 = (eco.items ?? ev.items ?? [])[0] ?? {};
          const val    = eco[nomePar] ?? ev[nomePar] ?? items0[nomePar];
          if (val === undefined || val === null || val === '') errosSet.add(nomePar);
        }
      }
      if (!regionReal && regionObrigatoria && !isEventoPrincipalGlobal(schemaEv)) errosSet.add('region');
    }
    const totalParams = contarParamsAplicaveisGlobal(schemaEv);
    const cobertura = Math.max(0, Math.round((1 - errosSet.size / totalParams) * 100));
    return { evento: nome, regiao, status: errosSet.size === 0 ? 'correto' : 'erro', cobertura, paramsErrados: [...errosSet], totalParams, peso, ignorarNoTotal: EVENTOS_IGNORAR_SEMPRE_GLOBAL.has(nome) };
  });

  // custom_user_info não tem entrada no schema — a estrutura é aninhada
  // (user_info.customer.*, user_info.address.*) e varia de formato entre marcas
  // (às vezes dentro de ecommerce.user_info, às vezes direto em ecommerce.*), então
  // não cabe no modelo padrão de parâmetros de raiz/items[]. Checagem dedicada: o
  // userId e o email têm que ser identificáveis onde quer que disparem — na prática
  // cada marca usa um campo diferente pro mesmo dado (Marca D manda
  // customer.userId; marca-a e Marca E só mandam customer.id; Marca E ainda tem um
  // userId solto dentro de address, sem relação com customer) — checa os lugares
  // reais já observados nos dados, não um caminho fixo só. O resto do perfil
  // (telefone, nome, nascimento, documento, gênero) é informativo e nunca conta
  // como erro. Mesma convenção dos demais eventos: erro agrega qualquer ocorrência
  // que faltou o campo, na sessão toda. Sessões do App nunca disparam esse evento
  // (confirmado em 298 sessões reais) — sempre cai no branch "ausente" abaixo,
  // que essa mudança de regra não altera.
  const rawDlEvents = sessao.dlEvents ?? sessao.payload?.dlEvents ?? [];
  const userInfoOcorrencias = rawDlEvents.filter(dl => {
    const ev = dl.event ?? dl;
    const evNome = ev.event ?? ev.event_name ?? '';
    return evNome === 'custom_user_info' || evNome === 'user_info';
  });
  if (userInfoOcorrencias.length === 0) {
    resultado.push({ evento: 'user_info', regiao: null, status: 'ausente', cobertura: 0, paramsErrados: [] });
  } else {
    const errosSet = new Set();
    // Cobertura = média da cobertura de CADA disparo, não união de erros da sessão
    // inteira — um único disparo vazio (ex.: antes do login) não pode derrubar a
    // cobertura de um evento que disparou várias vezes completo depois. Pedido de
    // 19/08/2026, mesmo raciocínio pros eventos principais em geral.
    const coberturasPorDisparo = [];
    for (const dl of userInfoOcorrencias) {
      const ev = dl.event ?? dl;
      // tolera as 3 formas de aninhamento já observadas nos dados reais
      const userInfo = ev.user_info ?? ev.ecommerce?.user_info ?? ev.ecommerce ?? {};
      const customer = userInfo.customer ?? {};
      const address  = userInfo.address ?? {};
      let errosOcorrencia = 0;
      if (!(customer.userId || customer.id || address.userId || address.id)) { errosSet.add('userId'); errosOcorrencia++; }
      if (!(customer.email || address.email)) { errosSet.add('email'); errosOcorrencia++; }
      coberturasPorDisparo.push(Math.round((1 - errosOcorrencia / 2) * 100));
    }
    const statusUserInfo = modo === 'disparos' ? 'correto' : (errosSet.size === 0 ? 'correto' : 'erro');
    resultado.push({
      evento: 'user_info', regiao: null, status: statusUserInfo,
      cobertura: Math.round(coberturasPorDisparo.reduce((s, c) => s + c, 0) / coberturasPorDisparo.length),
      paramsErrados: [...errosSet], peso: 1,
    });
  }


  // Exclui do total checkpoints marcados ignorarNoTotal (ex.: "error" ausente,
  // que é o esperado e não deve contar como falha nem como checkpoint).
  const contaveis    = resultado.filter(r => !r.ignorarNoTotal);
  const total        = contaveis.reduce((s, r) => s + (r.peso ?? 1), 0);
  // corretosPeso pondera pelo peso do checkpoint (usado só pro cálculo do score);
  // corretos é a contagem simples de eventos corretos — é isso que a Overview usa como
  // "Disparos corretos" (número inteiro de eventos), não uma soma ponderada fracionária.
  const corretosPeso = contaveis.filter(r => r.status === 'correto').reduce((s, r) => s + (r.peso ?? 1), 0);
  const corretos     = contaveis.filter(r => r.status === 'correto').length;
  const erros        = contaveis.filter(r => r.status === 'erro').length;
  const ausentes     = contaveis.filter(r => r.status === 'ausente').length;
  const score        = total > 0 ? Math.round((corretosPeso / total) * 100) : 0;

  // Cobertura por parâmetro (agrega params do schema, únicos por nome, só conta eventos que
  // dispararam). Usa eventosAplicaveis (já colapsado pra select_content/notify_me) em vez
  // do schema.events bruto — senão, pós-colapso, as linhas de região originais (Home, Menu
  // etc.) nunca mais dão match no resultado (que só tem "Todas as Páginas"), perdendo a
  // cobertura de parâmetros desses eventos por completo.
  const paramMap = {};
  eventosAplicaveis.forEach(schemaEv => {
    const r = resultado.find(x => x.evento === schemaEv.event && x.regiao === schemaEv.regiao);
    if (!r || r.status === 'ausente') return;
    (schemaEv.parameters ?? []).forEach(param => {
      const arrayMatch = param.path && param.path.match(/^(\w+)\[\]\.(.+)$/);
      const pname = arrayMatch ? arrayMatch[2] : (param.path ? param.path.replace('items[].', '') : param.name);
      if (!paramMap[pname]) paramMap[pname] = { name: pname, total: 0, ok: 0 };
      paramMap[pname].total++;
      if (!r.paramsErrados.includes(pname)) paramMap[pname].ok++;
    });
  });
  const parametros = Object.values(paramMap).map(p => ({ name: p.name, cobertura: p.total > 0 ? Math.round((p.ok/p.total)*100) : 0, total: p.total }));

  // Mesma agregação acima, mas restrita aos eventos principais — usada pela coluna
  // "Parâmetros" da área de saúde quando o filtro está em "Eventos principais", em vez
  // da cobertura de todos os eventos do schema (que fica sempre em "parametros").
  const paramMapPrincipais = {};
  schema.events.forEach(schemaEv => {
    if (!isEventoPrincipalGlobal(schemaEv)) return;
    const r = resultado.find(x => x.evento === schemaEv.event && x.regiao === schemaEv.regiao);
    if (!r || r.status === 'ausente') return;
    (schemaEv.parameters ?? []).forEach(param => {
      const arrayMatch = param.path && param.path.match(/^(\w+)\[\]\.(.+)$/);
      const pname = arrayMatch ? arrayMatch[2] : (param.path ? param.path.replace('items[].', '') : param.name);
      if (!paramMapPrincipais[pname]) paramMapPrincipais[pname] = { name: pname, total: 0, ok: 0 };
      paramMapPrincipais[pname].total++;
      if (!r.paramsErrados.includes(pname)) paramMapPrincipais[pname].ok++;
    });
  });
  // user_info não tem entrada no schema.json, então nunca passa pelo loop acima —
  // soma aqui direto, reaproveitando userInfoOcorrencias já calculado. Pedido da
  // equipe em 12/08: user_info agora conta como evento principal no Web
  // (dashboard/src/health/eventos-principais.js), com userId/email como parâmetros
  // principais. Não mexe no App (calcularScoreSessaoApp é função separada).
  if (userInfoOcorrencias.length > 0) {
    let okUserId = 0, okEmail = 0;
    for (const dl of userInfoOcorrencias) {
      const ev = dl.event ?? dl;
      const userInfo = ev.user_info ?? ev.ecommerce?.user_info ?? ev.ecommerce ?? {};
      const customer = userInfo.customer ?? {};
      const address  = userInfo.address ?? {};
      if (customer.userId || customer.id || address.userId || address.id) okUserId++;
      if (customer.email || address.email) okEmail++;
    }
    paramMapPrincipais['userId'] = { name: 'userId', total: userInfoOcorrencias.length, ok: okUserId };
    paramMapPrincipais['email']  = { name: 'email',  total: userInfoOcorrencias.length, ok: okEmail };
  }
  const parametrosPrincipais = Object.values(paramMapPrincipais).map(p => ({ name: p.name, cobertura: p.total > 0 ? Math.round((p.ok/p.total)*100) : 0, total: p.total }));

  return { score, corretos, erros, ausentes, total, eventos: resultado, parametros, parametrosPrincipais };
}

app.get('/api/health/overview', async (req, res) => {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH ?? 'main';
  const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };

  // Carrega schema (mesma fonte que /api/health-session usa)
  let schema;
  const schemaLocal = path.join(__dirname, 'schema.json');
  try {
    if (fs.existsSync(schemaLocal)) {
      schema = JSON.parse(fs.readFileSync(schemaLocal));
    } else if (token && repo) {
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/schema.json?ref=${branch}`, { headers });
      if (r.ok) { const file = await r.json(); schema = JSON.parse(Buffer.from(file.content, 'base64').toString()); }
    }
  } catch {}
  if (!schema) return res.json({ mediaGeral: 0, totalEventos: 0, marcas: [] });

  // Carrega lista de marcas
  let marcaIds = [];
  const testsDir = path.join(__dirname, 'tests');
  if (fs.existsSync(testsDir)) {
    marcaIds = fs.readdirSync(testsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } else if (token && repo) {
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/tests?ref=${branch}`, { headers });
      if (r.ok) { const d = await r.json(); marcaIds = d.filter(f => f.type === 'dir').map(f => f.name); }
    } catch {}
  }

  const marcasHealth = await Promise.all(marcaIds.map(async marca => {
    // 1. Busca sessão de saúde definida para a marca
    let sessionId = null;
    // GitHub tem prioridade — dados dinâmicos nunca devem vir de arquivo local do container
    if (token && repo) {
      try {
        const r = await fetch(`https://api.github.com/repos/${repo}/contents/config/health-${marca}.json?ref=${branch}`, { headers });
        if (r.ok) { const f = await r.json(); sessionId = JSON.parse(Buffer.from(f.content, 'base64').toString()).sessionId; }
      } catch {}
    }
    if (!sessionId) {
      const localHealthSet = path.join(__dirname, 'config', `health-${marca}.json`);
      if (fs.existsSync(localHealthSet)) sessionId = JSON.parse(fs.readFileSync(localHealthSet)).sessionId;
    }
    if (!sessionId) return { marca, pct: 0, adequados: 0, atencao: 0, criticos: 0, total: 0, semSessao: true };

    // 2. Carrega a sessão de saúde
    let sessao;
    // GitHub tem prioridade — sessões são gravadas no GitHub pela extensão
    if (token && repo) {
      try {
        const r = await fetch(`https://api.github.com/repos/${repo}/contents/sessions/${marca}/${sessionId}.json?ref=${branch}`, { headers });
        if (r.ok) {
          const meta = await r.json();
          if (meta.content) sessao = JSON.parse(Buffer.from(meta.content, 'base64').toString());
          else if (meta.download_url) { const dl = await fetch(meta.download_url, { headers }); sessao = await dl.json(); }
        }
      } catch {}
    }
    if (!sessao) {
      const localSession = path.join(__dirname, 'sessions', marca, `${sessionId}.json`);
      if (fs.existsSync(localSession)) sessao = JSON.parse(fs.readFileSync(localSession));
    }
    if (!sessao) return { marca, pct: 0, adequados: 0, atencao: 0, criticos: 0, total: 0, semSessao: true };

    // 3. Calcula score (corretos / erros / ausentes vs schema)
    const modo = 'disparos'; // saúde considera apenas se o evento disparou, não erros de parâmetro
    const { score, corretos, erros, ausentes, total, eventos, parametros, parametrosPrincipais } = calcularScoreSessao(sessao, schema, modo);
    return { marca, pct: score, adequados: corretos, atencao: 0, criticos: erros, ausentes, total, sessaoNome: sessao.nome, dataGravacao: sessao.timestamp || null, eventos, parametros, parametrosPrincipais };
  }));

  const validas    = marcasHealth.filter(m => !m.semSessao);
  const mediaGeral = validas.length > 0 ? Math.round(validas.reduce((s, m) => s + m.pct, 0) / validas.length) : 0;
  // Total de eventos aplicáveis ao Web — mesmo filtro de plataforma usado dentro de
  // calcularScoreSessao, senão o total conta também eventos só de App (marcas_site vazio).
  const totalEvs = schema.events.filter(ev => (ev.marcas_site ?? []).length > 0).length;

  // Agrega cobertura por evento (média entre marcas que têm o evento disparado)
  // Apenas view_item_list é separado por região (PDC vs outras) — demais eventos
  // são agregados juntos independente da região para não poluir a visão
  const EVENTOS_COM_QUEBRA_REGIAO = ['view_item_list'];
  const eventoAgg = {};
  for (const m of validas) {
    for (const e of m.eventos ?? []) {
      if (e.status === 'ausente') continue; // só conta marcas onde o evento disparou
      const quebra = EVENTOS_COM_QUEBRA_REGIAO.includes(e.evento);
      const key    = quebra ? e.evento + '::' + (e.regiao ?? '') : e.evento;
      if (!eventoAgg[key]) eventoAgg[key] = { evento: e.evento, regiao: quebra ? e.regiao : null, somaCobertura: 0, marcas: 0 };
      eventoAgg[key].somaCobertura += e.cobertura;
      eventoAgg[key].marcas++;
    }
  }
  const eventosAgregados = Object.values(eventoAgg).map(e => ({
    evento: e.evento, regiao: e.regiao, cobertura: Math.round(e.somaCobertura / e.marcas), marcas: e.marcas,
  }));

  // Agrega cobertura por parâmetro (média entre marcas)
  const paramAgg = {};
  for (const m of validas) {
    for (const p of m.parametros ?? []) {
      if (!paramAgg[p.name]) paramAgg[p.name] = { name: p.name, somaCobertura: 0, marcas: 0 };
      paramAgg[p.name].somaCobertura += p.cobertura;
      paramAgg[p.name].marcas++;
    }
  }
  const parametrosAgregados = Object.values(paramAgg)
    .map(p => ({ name: p.name, cobertura: Math.round(p.somaCobertura / p.marcas), marcas: p.marcas }))
    .sort((a, b) => a.cobertura - b.cobertura);

  res.json({ mediaGeral, totalEventos: totalEvs, marcas: marcasHealth, eventosAgregados, parametrosAgregados });
});

app.get('/api/health/:marca', async (req, res) => {
  const { marca } = req.params;
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH ?? 'main';

  let sessions = [];

  // Carrega todas as sessões (local ou GitHub)
  if (!token || !repo) {
    const dir = path.join(__dirname, 'sessions', marca);
    if (fs.existsSync(dir)) {
      sessions = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(dir, f))));
    }
  } else {
    try {
      const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
      const resp = await fetch(`https://api.github.com/repos/${repo}/contents/sessions/${marca}?ref=${branch}`, { headers });
      if (resp.ok) {
        const files = await resp.json();
        sessions = await Promise.all(
          files.filter(f => f.name.endsWith('.json')).map(async f => {
            try {
              const r = await fetch(f.download_url, { headers });
              return r.ok ? r.json() : null;
            } catch { return null; }
          })
        );
        sessions = sessions.filter(Boolean);
      }
    } catch (e) { console.error('Health load error:', e.message); }
  }

  if (!sessions.length) return res.json({ eventos: [], resumo: { total: 0, passou: 0, falhou: 0, pct: 0 }, sessoes: 0 });

  // Agrega por nome de evento
  const mapa = {};

  for (const sessao of sessions) {
    const eventos = sessao.validacao?.eventos ?? [];
    for (const ev of eventos) {
      const nome = ev.event;
      if (!nome) continue;
      if (!mapa[nome]) {
        mapa[nome] = {
          evento:    nome,
          total:     0,
          passou:    0,
          falhou:    0,
          desconhecido: 0,
          erros:     {},   // erro → count
          warnings:  {},
          sessoes:   new Set(),
        };
      }
      const m = mapa[nome];
      m.total++;
      if (ev.status === 'passou')       m.passou++;
      else if (ev.status === 'falhou')  m.falhou++;
      else                              m.desconhecido++;
      m.sessoes.add(sessao.nome ?? sessao.timestamp ?? 'desconhecida');
      (ev.errors ?? []).forEach(e => { m.erros[e] = (m.erros[e] ?? 0) + 1; });
      (ev.warnings ?? []).forEach(w => { m.warnings[w] = (m.warnings[w] ?? 0) + 1; });
    }
  }

  // Converte para array ordenado por % de falha
  const eventos = Object.values(mapa).map(m => ({
    evento:       m.evento,
    total:        m.total,
    passou:       m.passou,
    falhou:       m.falhou,
    desconhecido: m.desconhecido,
    pct:          m.total > 0 ? Math.round((m.passou / m.total) * 100) : 0,
    erros:        Object.entries(m.erros).sort((a,b) => b[1]-a[1]).slice(0, 5).map(([msg, count]) => ({ msg, count })),
    warnings:     Object.entries(m.warnings).sort((a,b) => b[1]-a[1]).slice(0, 3).map(([msg, count]) => ({ msg, count })),
    sessoes:      m.sessoes.size,
  })).sort((a, b) => a.pct - b.pct);

  // Filtra eventos do schema (ignora gtm.*, oppuz:*, deco, etc.)
  const eventosMedidos = eventos.filter(e =>
    !e.evento.startsWith('gtm.') &&
    !e.evento.startsWith('oppuz:') &&
    !['deco', 'OneTrustLoaded', 'OptanonLoaded', 'OneTrustGroupsUpdated', 'virtual_pageview'].includes(e.evento)
  );

  const totalOcorrencias = eventosMedidos.reduce((s, e) => s + e.total, 0);
  const totalPassou      = eventosMedidos.reduce((s, e) => s + e.passou, 0);

  res.json({
    eventos:   eventosMedidos,
    todos:     eventos,
    resumo: {
      total:  totalOcorrencias,
      passou: totalPassou,
      falhou: eventosMedidos.reduce((s, e) => s + e.falhou, 0),
      pct:    totalOcorrencias > 0 ? Math.round((totalPassou / totalOcorrencias) * 100) : 0,
    },
    sessoes: sessions.length,
  });
});


// ─── SAÚDE DE UMA SESSÃO vs SCHEMA ───────────────────────────────────────────
app.get('/api/health-session/:marca/:sessionId', async (req, res) => {
  const { marca, sessionId } = req.params;
  try {

  // 1. Carrega a sessão — suporta arquivos > 1MB via download_url
  // GitHub tem prioridade — sessões são gravadas no GitHub pela extensão
  let sessao;
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH ?? 'main';
  const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
  if (token && repo) {
    try {
      const metaResp = await fetch(`https://api.github.com/repos/${repo}/contents/sessions/${marca}/${sessionId}.json?ref=${branch}`, { headers });
      if (metaResp.ok) {
        const meta = await metaResp.json();
        if (meta.content) sessao = JSON.parse(Buffer.from(meta.content, 'base64').toString());
        else if (meta.download_url) { const dl = await fetch(meta.download_url, { headers }); sessao = await dl.json(); }
      }
    } catch {}
  }
  if (!sessao) {
    const localPath = path.join(__dirname, 'sessions', marca, `${sessionId}.json`);
    if (fs.existsSync(localPath)) sessao = JSON.parse(fs.readFileSync(localPath));
  }
  if (!sessao) return res.status(404).json({ error: 'Sessão não encontrada' });

  // 2. Carrega schema — local primeiro, depois GitHub
  let schema;
  const schemaLocal = path.join(__dirname, 'schema.json');
  if (fs.existsSync(schemaLocal)) {
    schema = JSON.parse(fs.readFileSync(schemaLocal));
  } else {
    const token  = process.env.GITHUB_TOKEN;
    const repo   = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH ?? 'main';
    const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
    const resp = await fetch(`https://api.github.com/repos/${repo}/contents/schema.json?ref=${branch}`, { headers });
    if (!resp.ok) return res.status(404).json({ error: 'schema.json não encontrado' });
    const file = await resp.json();
    schema = JSON.parse(Buffer.from(file.content, 'base64').toString());
  }

  const dlEvents = resolverDlEvents(sessao);

  // Normaliza region do schema para comparar com o valor real do evento
  function normalizarRegiao(r) {
    if (!r) return null;
    return removerAcentosGlobal(r.toLowerCase()).replace('todas as paginas', 'all').replace(/[-\s]/g, '').trim();
  }

  function extrairRegionEvento(dl) {
    const ev  = dl.event ?? dl;
    const eco = ev.ecommerce ?? {};
    // Tenta em ordem: ecommerce.region, event.region, ecommerce.local, event.local
    const r = eco.region ?? ev.region ?? null;
    return r ? String(r).toLowerCase().trim() : null;
  }

  // 3. Para cada evento do schema aplicável à plataforma e marca, verifica se disparou
  const ambiente = sessao.ambiente ?? 'web';
  const campoMarcas = ambiente === 'app' ? 'marcas_app' : 'marcas_site';

  const eventosAplicaveisBrutos = schema.events.filter(ev => {
    const marcasPlat = ev[campoMarcas] ?? [];
    if (!marcasPlat.length) return false;
    if (!marca) return true;
    return marcasPlat.includes(marca);
  });
  // select_content/notify_me nunca mandam region real (EVENTOS_SEM_REGIAO_REAL_GLOBAL) —
  // colapsa as N linhas de região do schema numa só por marca (mesmo critério de
  // calcularScoreSessao/Overview).
  const eventosAplicaveis = [];
  const jaColapsadoRegiaoSessao = new Set();
  for (const ev of eventosAplicaveisBrutos) {
    if (!EVENTOS_SEM_REGIAO_REAL_GLOBAL.has(ev.event)) { eventosAplicaveis.push(ev); continue; }
    if (jaColapsadoRegiaoSessao.has(ev.event)) continue;
    jaColapsadoRegiaoSessao.add(ev.event);
    eventosAplicaveis.push({ ...ev, regiao: 'Todas as Páginas' });
  }

  const resultado = eventosAplicaveis.map(schemaEv => {
    const nome         = schemaEv.event;
    const regiao       = schemaEv.regiao;
    const regiaoNorm   = normalizarRegiao(regiao);
    const isTodas      = regiaoNorm === 'all' || regiaoNorm === 'todasaspaginas';
    const temRegiaoRealNaSessao = algumDisparoComRegiaoGlobal(dlEvents, nome, extrairRegionEvento);

    // Region só é obrigatória quando o evento aparece em múltiplas regiões no schema
    // E declara "region" como parâmetro real — eventos como select_content/notify_me
    // têm várias linhas de região só por organização do schema, nunca por um campo
    // "region" de verdade no payload.
    const ocorrenciasNoSchema = eventosAplicaveis.filter(e => e.event === nome).length;
    const declaraRegionParam  = (schemaEv.parameters ?? []).some(p => p.name === 'region');
    const regionObrigatoria   = ocorrenciasNoSchema > 1 && declaraRegionParam && !EVENTOS_SEM_REGION_OBRIGATORIA_WEB.has(nome);

    // Filtra eventos da sessão que correspondem a este evento E à região do schema
    // Normaliza custom_X → X para encontrar alias no DL
    const ocorrencias = dlEvents.filter(dl => {
      const ev = dl.event ?? dl;
      const evNome = ev.event ?? ev.event_name ?? '';
      const evNomeNorm = evNome.startsWith('custom_') ? evNome.replace('custom_', '') : evNome;
      const nomeMatch = (evNome === nome) || (evNomeNorm === nome) || (`custom_${evNome}` === nome);
      if (!nomeMatch) return false;
      if (isTodas) return true;
      // Se o schema tem região, verifica se o evento disparou nessa região
      if (regiaoNorm) {
        const regionEvento = extrairRegionEvento(dl);
        if (!regionEvento) {
          // URL de checkout é pista não ambígua (ver regiaoPelaUrlGlobal).
          // A dedução por URL só vale POSITIVAMENTE: se ela aponta para esta região, aceita.
          // Se aponta para outra, NÃO rejeita — cai no fallback de sempre. Rejeitar aqui tirava
          // disparo que antes contava: na marca-j o begin_checkout dispara sem region fora da URL
          // de checkout e era aceito por ninguém daquele evento informar região; com a rejeição
          // ele sumiu, junto com add_payment_info, add_shipping_info e add_personal_info, mais o
          // search da Busca da marca-b. Cinco presentes viraram ausentes de uma vez.
          if (regiaoPelaUrlGlobal(dl) === regiaoNorm) return true;
          // Região única no schema: sem ambiguidade, disparo sem region conta para ela (mesma
          // regra de calcularScoreSessao). Senão, só aceita se NINGUÉM informou região.
          return ocorrenciasNoSchema === 1 || !temRegiaoRealNaSessao;
        }
        return aplicarAliasRegiaoGlobal(nome, normalizarRegiao(regionEvento)) === regiaoNorm;
      }
      return true;
    });

    // Eventos em EVENTOS_IGNORAR_SEMPRE_GLOBAL (ex.: "error") ausentes são esperados —
    // não conta como checkpoint ausente, fica de fora do total (mesmo critério de
    // calcularScoreSessao/Overview/App). Mesma coisa pra combinação marca+evento+região em
    // EVENTOS_OPCIONAIS_POR_MARCA_REGIAO_GLOBAL (ex.: view_item_list no Checkout/Mini-cart
    // da Marca D — feature ainda não implementada).
    if (ocorrencias.length === 0) {
      if (EVENTOS_IGNORAR_SEMPRE_GLOBAL.has(nome) || ehOpcionalGlobal(marca, nome, regiao)) {
        return { evento: nome, regiao, status: 'ausente', ocorrencias: 0, erros: [], detalhes: [], regionReal: null, cobertura: 0, ignorarNoTotal: true };
      }
      // Verifica se o evento disparou mas com region diferente — não faz sentido pra
      // eventos que organicamente aparecem em várias regiões sem nunca terem "region"
      // real no payload (ex.: select_content), já que "mismatch" ali é comportamento normal.
      const disparouOutraRegiao = EVENTOS_SEM_REGION_OBRIGATORIA_WEB.has(nome) ? [] : dlEvents.filter(dl => {
        const ev = dl.event ?? dl;
        return (ev.event === nome || ev.event_name === nome);
      });
      if (disparouOutraRegiao.length > 0) {
        const regioes = [...new Set(disparouOutraRegiao.map(dl => extrairRegionEvento(dl)).filter(Boolean))];
        return {
          evento: nome, regiao, status: 'ausente', ocorrencias: 0, erros: [], cobertura: 0,
          detalhes: [], regionReal: null,
          aviso: regioes.length > 0
            ? 'Disparou com region "' + regioes.join('", "') + '" — schema espera "' + (regiao ?? '?').toLowerCase() + '"'
            : 'Disparou sem parâmetro region — verificar implementação',
        };
      }
      return { evento: nome, regiao, status: 'ausente', ocorrencias: 0, erros: [], detalhes: [], regionReal: null, cobertura: 0 };
    }

    // Peso reduzido para o evento "error": quando ele dispara, pesa menos no score
    // geral do que os demais checkpoints (é esperado que apareça pouco).
    const peso = nome === 'error' ? 0.5 : 1;

    // Verifica parâmetros em cada ocorrência
    const PARAMS_WEB_ONLY = PARAMS_WEB_ONLY_GLOBAL;
    const EVENTOS_SEM_ITEMS = EVENTOS_SEM_ITEMS_GLOBAL;

    // Quando o MESMO disparo (mesmo instante) dispara mais de uma vez no GA4 (hit duplicado
    // pra Google Ads + GA4 Analytics), usa só a ocorrência mais completa como referência
    // DAQUELE instante — disparos genuinamente repetidos (ex.: 10 view_item_list em
    // momentos diferentes) continuam TODOS contando pro union de erros abaixo. Exceção:
    // eventos em EVENTOS_MELHOR_DISPARO_UNICO_GLOBAL usam só o disparo mais completo da
    // sessão toda como referência única.
    let ocorrenciasRef = EVENTOS_MELHOR_DISPARO_UNICO_GLOBAL.has(nome)
      ? ocorrenciaMaisCompleta(ocorrencias, schemaEv, nome, regionObrigatoria)
      : ocorrenciasReferencia(ocorrencias, schemaEv, nome, regionObrigatoria);

    function buscarCandidatoDLSessao() {
      const rawDlEvents = sessao.dlEvents ?? sessao.payload?.dlEvents ?? [];
      const candidatosDL = rawDlEvents.filter(dl => {
        const ev = dl.event ?? dl;
        const evNome = ev.event ?? ev.event_name ?? '';
        const evNomeNorm = evNome.startsWith('custom_') ? evNome.replace('custom_', '') : evNome;
        const nomeMatch = (evNome === nome) || (evNomeNorm === nome) || (`custom_${evNome}` === nome);
        if (!nomeMatch) return false;
        if (isTodas) return true;
        if (regiaoNorm) {
          const regionEvento = extrairRegionEvento(dl);
          if (!regionEvento) return !temRegiaoRealNaSessao;
          return aplicarAliasRegiaoGlobal(nome, normalizarRegiao(regionEvento)) === regiaoNorm;
        }
        return true;
      });
      return candidatosDL.length ? ocorrenciaMaisCompleta(candidatosDL, schemaEv, nome, regionObrigatoria)[0] : null;
    }

    // Tag legada (dimension1/2/3) OU evento nativo da plataforma (sem "brand") pode
    // acontecer em QUALQUER um dos disparos genuínos — checa cada referência
    // independentemente e desconsidera o disparo do GA4 em favor do "custom_..." do
    // DataLayer, sempre que ele existir.
    ocorrenciasRef = ocorrenciasRef.map(ref => {
      if (!temDimensaoGenericaLegado(ref) && !pareceEventoNativoPlataforma(ref)) return ref;
      return buscarCandidatoDLSessao() ?? ref;
    });

    // Fallback pro "essencialmente vazio" só faz sentido quando há um ÚNICO disparo real
    // na sessão.
    if (ocorrenciasRef.length === 1) {
      const errosRef = contarErrosOcorrenciaWeb(ocorrenciasRef[0], schemaEv, nome, regionObrigatoria);
      const totalCheckavel = Math.max(contarChecksOcorrenciaWeb(ocorrenciasRef[0], schemaEv, nome, regionObrigatoria), 1);
      if (errosRef >= totalCheckavel) {
        const melhorDL = buscarCandidatoDLSessao();
        if (melhorDL) {
          const errosDL = contarErrosOcorrenciaWeb(melhorDL, schemaEv, nome, regionObrigatoria);
          if (errosDL < errosRef) ocorrenciasRef = [melhorDL];
        }
      }
    }

    const errosSet = new Set();
    const detalhes = [];
    const regioesReais = new Set();

    for (const dl of ocorrenciasRef) {
      const ev   = dl.event ?? dl;
      const eco  = ev.ecommerce ?? ev;
      const errosOcorrencia = [];

      // Captura region real do evento (só ecommerce.region ou ev.region — não local)
      const regionReal = eco.region ?? ev.region ?? null;
      if (regionReal) regioesReais.add(String(regionReal));

      for (const param of schemaEv.parameters ?? []) {
        const nomePar = param.name;
        const path    = param.path; // ex: "items[].item_id", "shippings[].shipping" ou null
        // Interpreta path de array genérico "chave[].campo" — não só "items[]." (ex.:
        // "shippings[]." do search_zipcode), senão o campo nunca é achado no lugar certo.
        const arrayMatch = path && path.match(/^(\w+)\[\]\.(.+)$/);
        const fieldName = arrayMatch ? arrayMatch[2] : (path ? path.replace('items[].', '') : nomePar);

        // Ignora params que só existem no DL web
        if (PARAMS_WEB_ONLY.has(fieldName) || PARAMS_IGNORAR_SEMPRE_GLOBAL.has(fieldName)) continue;
        if (PARAMS_IGNORAR_POR_MARCA_GLOBAL[marca]?.has(fieldName)) continue; // exceção por marca
        if (param.required === false) continue; // respeita required:false do schema
        // Eventos principais: só os 6 campos curados contam pra saúde (ver constante)
        if (isEventoPrincipalGlobal(schemaEv) && !PARAMS_SAUDE_EVENTOS_PRINCIPAIS_GLOBAL.has(fieldName)) continue;

        if (arrayMatch) {
          // Parâmetro dentro de um array (items[], shippings[], etc.)
          const [, arrayKey, campo] = arrayMatch;
          const arr = asArray(eco[arrayKey] ?? ev[arrayKey]);
          // Eventos com items[] opcional (ex.: view_promotion/select_promotion sem produto
          // vinculado): array vazio não é erro, mas se vier com dados, valida normalmente.
          // A isenção só vale pro array "items" — outros arrays (ex. shippings) continuam exigidos.
          if (!arr.length) {
            if (!(arrayKey === 'items' && EVENTOS_SEM_ITEMS.has(nome))) errosOcorrencia.push(`${arrayKey}: array ausente`);
          } else {
            arr.forEach((item, idx) => {
              // coupon é documentado como campo do item, mas na prática a marca manda
              // no nível do pedido (ecommerce.coupon) — aceitar de onde vier.
              const val = item[campo] ?? (campo === 'coupon' ? (eco[campo] ?? ev[campo]) : undefined);
              if (val === undefined || val === null || val === '') {
                errosOcorrencia.push(`${arrayKey}[${idx}].${campo}: ausente`);
              }
            });
          }
        } else {
          // Parâmetro direto no evento ou ecommerce —
          // se não achar no nível raiz, tenta dentro de eco.items[] (params de produto)
          // Para view_promotion/select_promotion, skip do param "items" raiz
          if (nomePar === 'items' && EVENTOS_SEM_ITEMS.has(nome)) continue;
          if (nomePar === 'items' && EVENTOS_SEM_ITEMS.has(nome)) continue;
          const items  = eco.items ?? ev.items ?? [];
          const item0  = items[0] ?? {};
          const val    = eco[nomePar] ?? ev[nomePar] ?? item0[nomePar];
          if (val === undefined || val === null || val === '') {
            errosOcorrencia.push(`${nomePar}: ausente`);
          } else if (param.type === 'string' && typeof val !== 'string') {
            errosOcorrencia.push(`${nomePar}: esperado string, recebido ${typeof val}`);
          } else if (param.type === 'number' && typeof val !== 'number') {
            errosOcorrencia.push(`${nomePar}: esperado number, recebido ${typeof val}`);
          } else if (param.type === 'array' && !Array.isArray(val)) {
            errosOcorrencia.push(`${nomePar}: esperado array`);
          }
        }
      }

      // Region obrigatória apenas quando evento aparece em múltiplas regiões no schema —
      // não conta pros eventos principais (só os 6 campos curados contam ali).
      if (!regionReal && regionObrigatoria && !isEventoPrincipalGlobal(schemaEv)) {
        errosOcorrencia.push('region: ausente');
      }

      errosOcorrencia.forEach(e => errosSet.add(e));
      detalhes.push({ url: dl.url ?? '', erros: errosOcorrencia });
    }

    const erros      = [...errosSet];
    const status     = erros.length === 0 ? 'correto' : 'erro';
    const regionReal = regioesReais.size > 0 ? [...regioesReais].join(', ') : null;

    // Cobertura do evento: % de parâmetros esperados que chegaram corretos
    const totalParams = contarParamsAplicaveisGlobal(schemaEv);
    const cobertura = status === 'ausente' ? 0 : Math.max(0, Math.round((1 - erros.length / totalParams) * 100));

    // Filtro final de segurança — remove PARAMS_WEB_ONLY dos erros
    const PARAMS_IGNORAR = ['seller_id','str_line_items','line_items','item_list_id','seller_cod_name','item_list_name','item_shipping_tier'];
    const errosFiltrados = erros.filter(e => {
      const e0 = e.split(':')[0].trim();
      const campo = e0.includes('].') ? e0.split('].').slice(-1)[0] : e0;
      return !PARAMS_IGNORAR.includes(campo);
    });
    // Disparou = correto, independente de parâmetro — mesmo critério do calcularScoreSessao/
    // Overview/App (modo "disparos"). Erro de parâmetro não derruba o status pra 'erro', só
    // fica listado em "erros" pro front marcar como "com aviso" (evento correto que dispara,
    // mas com parâmetro incorreto/ausente) — evita essa tela ficar mais rígida que o resto.
    const statusFinal = ocorrencias.length === 0 ? 'ausente' : 'correto';
    return { evento: nome, regiao, status: statusFinal, ocorrencias: ocorrencias.length, erros: errosFiltrados, detalhes, regionReal, cobertura, peso, ignorarNoTotal: EVENTOS_IGNORAR_SEMPRE_GLOBAL.has(nome) };
  });

  // custom_user_info não tem entrada no schema — mesma checagem dedicada de
  // calcularScoreSessao/Overview: o userId e o email têm que ser identificáveis onde
  // quer que disparem — cada marca usa um campo diferente pro mesmo dado (Carol
  // Bassi manda customer.userId; marca-a e Marca E só mandam customer.id; Marca E
  // ainda tem um userId dentro de address) — resto do perfil é informativo, nunca
  // conta como erro.
  const rawDlEventsUserInfo = sessao.dlEvents ?? sessao.payload?.dlEvents ?? [];
  const userInfoOcorrencias = rawDlEventsUserInfo.filter(dl => {
    const ev = dl.event ?? dl;
    const evNome = ev.event ?? ev.event_name ?? '';
    return evNome === 'custom_user_info' || evNome === 'user_info';
  });
  if (userInfoOcorrencias.length === 0) {
    resultado.push({ evento: 'user_info', regiao: null, status: 'ausente', ocorrencias: 0, erros: [], detalhes: [], regionReal: null, cobertura: 0 });
  } else {
    const errosSetUserInfo = new Set();
    // Cobertura = média da cobertura de CADA disparo, não união de erros da sessão
    // inteira — um único disparo vazio (ex.: antes do login) não pode derrubar a
    // cobertura de um evento que disparou várias vezes completo depois. Pedido de
    // 19/08/2026, mesmo raciocínio pros eventos principais em geral.
    const coberturasUserInfo = [];
    for (const dl of userInfoOcorrencias) {
      const ev = dl.event ?? dl;
      // tolera as 3 formas de aninhamento já observadas nos dados reais
      const userInfo = ev.user_info ?? ev.ecommerce?.user_info ?? ev.ecommerce ?? {};
      const customer = userInfo.customer ?? {};
      const address  = userInfo.address ?? {};
      let errosOcorrencia = 0;
      if (!(customer.userId || customer.id || address.userId || address.id)) { errosSetUserInfo.add('userId: ausente'); errosOcorrencia++; }
      if (!(customer.email || address.email)) { errosSetUserInfo.add('email: ausente'); errosOcorrencia++; }
      coberturasUserInfo.push(Math.round((1 - errosOcorrencia / 2) * 100));
    }
    const errosUserInfo = [...errosSetUserInfo];
    resultado.push({
      evento: 'user_info', regiao: null, status: 'correto', ocorrencias: userInfoOcorrencias.length,
      erros: errosUserInfo, detalhes: [], regionReal: null,
      cobertura: Math.round(coberturasUserInfo.reduce((s, c) => s + c, 0) / coberturasUserInfo.length), peso: 1,
    });
  }

  // 4. Score — "corretosTot" é qualquer disparo (independente de parâmetro), igual ao
  // calcularScoreSessao/Overview/App. "comAviso" é o subconjunto de corretosTot que tem
  // parâmetro com problema; "corretos" (exposto na resposta) fica só com os 100% limpos.
  // Exclui do total checkpoints marcados ignorarNoTotal (ex.: "error" ausente, que é o
  // esperado e não deve contar como falha nem como checkpoint), e pondera pelo peso
  // (ex.: "error" presente pesa 0.5 no total/corretosTot).
  const contaveis      = resultado.filter(r => !r.ignorarNoTotal);
  const total          = contaveis.reduce((s, r) => s + (r.peso ?? 1), 0);
  const corretosTotPeso = contaveis.filter(r => r.status === 'correto').reduce((s, r) => s + (r.peso ?? 1), 0);
  const corretosTot    = contaveis.filter(r => r.status === 'correto').length;
  const comAviso       = contaveis.filter(r => r.status === 'correto' && (r.erros ?? []).length > 0).length;
  const corretos       = corretosTot - comAviso;
  const ausentes       = contaveis.filter(r => r.status === 'ausente').length;
  const erros          = 0; // este endpoint não derruba status pra 'erro' — ver comentário acima
  const score          = total > 0 ? Math.round((corretosTotPeso / total) * 100) : 0;

  // 4b. Cobertura por parâmetro (agrega todos os params do schema, únicos por nome). Usa
  // eventosAplicaveis (já colapsado pra select_content/notify_me) — senão, pós-colapso, as
  // linhas de região originais nunca mais dão match no resultado (só tem "Todas as
  // Páginas"), perdendo a cobertura de parâmetros desses eventos por completo.
  const paramMap = {};
  eventosAplicaveis.forEach(schemaEv => {
    const r = resultado.find(x => x.evento === schemaEv.event && x.regiao === schemaEv.regiao);
    if (!r || r.status === 'ausente') return; // só conta eventos que dispararam
    (schemaEv.parameters ?? []).forEach(param => {
      const arrayMatch = param.path && param.path.match(/^(\w+)\[\]\.(.+)$/);
      const pname = arrayMatch ? arrayMatch[2] : (param.path ? param.path.replace('items[].', '') : param.name);
      if (!paramMap[pname]) paramMap[pname] = { name: pname, total: 0, ok: 0 };
      paramMap[pname].total++;
      const temErro = r.erros.some(e => e.startsWith(pname + ':') || e.includes('.' + pname + ':'));
      if (!temErro) paramMap[pname].ok++;
    });
  });
  const parametros = Object.values(paramMap)
    .map(p => ({ name: p.name, cobertura: p.total > 0 ? Math.round((p.ok / p.total) * 100) : 0, total: p.total }))
    .sort((a, b) => a.cobertura - b.cobertura);

  // Mesma agregação acima, mas restrita aos eventos principais — mesma lógica já usada em
  // calcularScoreSessao/Overview, portada aqui pra fechar o gap entre os dois endpoints.
  const paramMapPrincipais = {};
  schema.events.forEach(schemaEv => {
    if (!isEventoPrincipalGlobal(schemaEv)) return;
    const r = resultado.find(x => x.evento === schemaEv.event && x.regiao === schemaEv.regiao);
    if (!r || r.status === 'ausente') return;
    (schemaEv.parameters ?? []).forEach(param => {
      const arrayMatch = param.path && param.path.match(/^(\w+)\[\]\.(.+)$/);
      const pname = arrayMatch ? arrayMatch[2] : (param.path ? param.path.replace('items[].', '') : param.name);
      if (!paramMapPrincipais[pname]) paramMapPrincipais[pname] = { name: pname, total: 0, ok: 0 };
      paramMapPrincipais[pname].total++;
      const temErro = r.erros.some(e => e.startsWith(pname + ':') || e.includes('.' + pname + ':'));
      if (!temErro) paramMapPrincipais[pname].ok++;
    });
  });
  // user_info não tem entrada no schema.json, então nunca passa pelo loop acima —
  // soma aqui direto, reaproveitando userInfoOcorrencias já calculado. Mesmo
  // ajuste do calcularScoreSessao/Overview (Web), pedido da equipe em 12/08.
  if (userInfoOcorrencias.length > 0) {
    let okUserId = 0, okEmail = 0;
    for (const dl of userInfoOcorrencias) {
      const ev = dl.event ?? dl;
      const userInfo = ev.user_info ?? ev.ecommerce?.user_info ?? ev.ecommerce ?? {};
      const customer = userInfo.customer ?? {};
      const address  = userInfo.address ?? {};
      if (customer.userId || customer.id || address.userId || address.id) okUserId++;
      if (customer.email || address.email) okEmail++;
    }
    paramMapPrincipais['userId'] = { name: 'userId', total: userInfoOcorrencias.length, ok: okUserId };
    paramMapPrincipais['email']  = { name: 'email',  total: userInfoOcorrencias.length, ok: okEmail };
  }
  const parametrosPrincipais = Object.values(paramMapPrincipais)
    .map(p => ({ name: p.name, cobertura: p.total > 0 ? Math.round((p.ok / p.total) * 100) : 0, total: p.total }))
    .sort((a, b) => a.cobertura - b.cobertura);

  // Agrupa por região
  const porRegiao = {};
  for (const r of resultado) {
    const reg = r.regiao ?? 'Outras';
    if (!porRegiao[reg]) porRegiao[reg] = [];
    porRegiao[reg].push(r);
  }

  res.json({
    sessao:    { id: sessionId, nome: sessao.nome, timestamp: sessao.timestamp, startUrl: sessao.startUrl },
    schema:    { version: schema.version, total },
    score,
    corretos,
    comAviso,
    ausentes,
    erros,
    porRegiao,
    eventos:   resultado,
    parametros,
    parametrosPrincipais,
  });
  } catch(e) { console.error('health-session error:', e.message); return res.status(500).json({ error: 'Erro interno: ' + e.message }); }
});

// Lista sessões disponíveis para análise de saúde
app.get('/api/health-sessions/:marca', async (req, res) => {
  const { marca } = req.params;
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH ?? 'main';

  let sessions = [];
  if (!token || !repo) {
    const dir = path.join(__dirname, 'sessions', marca);
    if (fs.existsSync(dir)) {
      sessions = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f)));
        return { id: f.replace('.json',''), nome: d.nome, timestamp: d.timestamp, dlCount: d.dlEvents?.length ?? 0 };
      });
    }
  } else {
    try {
      const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
      const resp = await fetch(`https://api.github.com/repos/${repo}/contents/sessions/${marca}?ref=${branch}`, { headers });
      if (resp.ok) {
        const files = await resp.json();
        sessions = await Promise.all(
          files.filter(f => f.name.endsWith('.json')).map(async f => {
            try {
              const r = await fetch(f.download_url, { headers });
              if (!r.ok) return null;
              const d = await r.json();
              return { id: f.name.replace('.json',''), nome: d.nome, timestamp: d.timestamp, dlCount: d.dlEvents?.length ?? 0 };
            } catch { return null; }
          })
        );
        sessions = sessions.filter(Boolean);
      }
    } catch {}
  }

  res.json(sessions.sort((a,b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '')));
});


// ─── SESSÃO DE SAÚDE DEDICADA ─────────────────────────────────────────────────
// Salva/lê qual sessão é a "saúde oficial" de uma marca
app.post('/api/health-set/:marca', async (req, res) => {
  const { marca } = req.params;
  const { sessionId } = req.body;

  const dir      = path.join(__dirname, 'config');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `health-${marca}.json`);

  // sessionId null ou ausente = desmarcar sessão de saúde
  if (!sessionId) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    try {
      // Remove do GitHub — envia arquivo vazio sinalizando remoção
      await commitToGitHub(`config/health-${marca}.json`, JSON.stringify({ marca, sessionId: null, updatedAt: new Date().toISOString() }), `health-unset: ${marca}`);
    } catch {}
    return res.json({ ok: true, sessionId: null });
  }

  const data = { marca, sessionId, updatedAt: new Date().toISOString() };
  fs.writeFileSync(filePath, JSON.stringify(data));

  // Persiste no GitHub também
  try {
    await commitToGitHub(`config/health-${marca}.json`, JSON.stringify(data), `health-set: ${marca} -> ${sessionId}`);
  } catch {}

  res.json({ ok: true, sessionId });
});

app.get('/api/health-set/:marca', async (req, res) => {
  const { marca } = req.params;

  // GitHub primeiro — health-set é dado dinâmico, não pode vir do container
  try {
    const token  = process.env.GITHUB_TOKEN;
    const repo   = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH ?? 'main';
    const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
    const resp = await fetch(`https://api.github.com/repos/${repo}/contents/config/health-${marca}.json?ref=${branch}`, { headers });
    if (resp.ok) {
      const file = await resp.json();
      const data = JSON.parse(Buffer.from(file.content, 'base64').toString());
      // sessionId null = sessão desmarcada
      if (!data.sessionId) return res.json({ sessionId: null });
      return res.json(data);
    }
  } catch {}

  // Local como fallback de verdade — cobre ambientes sem GITHUB_TOKEN/GITHUB_REPO
  // (dev local) ou falha de rede, em vez de sempre cair em sessionId: null.
  try {
    const filePath = path.join(__dirname, 'config', `health-${marca}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return res.json(data.sessionId ? data : { sessionId: null });
    }
  } catch {}

  res.json({ sessionId: null });
});

app.post('/api/sessions/pdf-custom', async (req, res) => {
  const sessao = req.body;
  if (!sessao?.nome) return res.status(400).json({ error: 'Dados inválidos' });
  try {
    const { chromium } = require('@playwright/test');
    // Inicia Xvfb — display virtual com interface gráfica real
    // Permite hover CSS, animações e interações que não funcionam em headless
    let xvfbProc = null;
    const display = ':' + (99 + Math.floor(Math.random() * 100));
    try {
      const { spawn } = require('child_process');
      xvfbProc = spawn('Xvfb', [display, '-screen', '0', '1280x720x24', '-ac'], {
        detached: true, stdio: 'ignore'
      });
      xvfbProc.unref();
      await new Promise(r => setTimeout(r, 800));
    } catch {}

    const useHeaded = !!xvfbProc;
    if (useHeaded) process.env.DISPLAY = display;

    const browser = await chromium.launch({
      headless: !useHeaded,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        ...(useHeaded ? ['--disable-gpu'] : []),
      ],
    });
    const page    = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const html    = gerarHTMLRelatorio(sessao);
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' } });
    await browser.close();
    const nomeArquivo = `relatorio-${sessao.nome?.replace(/\s+/g, '-') ?? 'custom'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao gerar PDF: ' + e.message });
  }
});

app.get('/api/spec/:marca/:flowId', (req, res) => {
  const { marca, flowId } = req.params;
  const filePath = path.join(__dirname, 'tests', marca, `${flowId}.spec.js`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Spec não encontrado' });
  res.type('text').send(fs.readFileSync(filePath, 'utf-8'));
});

app.get('/api/diagnostico', async (req, res) => {
  const { chromium } = require('@playwright/test');
  try {
    const browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const page = await browser.newPage();
    await page.goto('https://www.google.com');
    const title = await page.title();
    await browser.close();
    res.json({ success: true, title });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/diagnostico-github', async (req, res) => {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token || !repo) {
    return res.json({ erro: 'Variáveis não configuradas', token: !!token, repo, branch });
  }

  try {
    const result = await commitToGitHub(
      'tests/_diagnostico.txt',
      `teste ${new Date().toISOString()}`,
      'diagnostico: teste de commit'
    );
    res.json({ success: true, repo, branch, result: JSON.stringify(result).slice(0, 300) });
  } catch (e) {
    res.json({ erro: e.message });
  }
});

// ─── FUNÇÕES DE PARSE ─────────────────────────────────────────────────────────

function extraiConsolePorSpec(spec) {
  const msgs = [];
  spec.tests?.forEach(test => {
    test.results?.forEach(result => {
      result.stdout?.forEach(entry => { if (entry.text) msgs.push(entry.text); });
    });
  });
  return msgs.join('\n');
}

function parseConsoleReport(text) {
  const eventos = [];
  const lines   = text.split('\n');
  let current   = null;

  for (const line of lines) {
    if (line.includes('INCONSISTÊNCIAS') || line.includes('EVENTOS GA4') ||
        line.includes('COMPARAÇÃO DATALAYER') ||
        (line.includes('Produto:') && line.includes('item_id:'))) break;

    const match = line.match(/\[(\d+)\] (✅|❌|❓) (.+?)(?:\s+\((.+?)\))?$/);
    if (match) {
      if (current) eventos.push(current);
      current = {
        index:  parseInt(match[1]),
        status: match[2] === '✅' ? 'passou' : match[2] === '❌' ? 'falhou' : 'desconhecido',
        name:   match[3].trim(),
        regiao: match[4] ?? null,
        errors: [], warnings: [], passed: [],
      };
      continue;
    }
    if (current) {
      const t = line.trim();
      if (t.startsWith('❌'))                            current.errors.push(t.replace('❌', '').trim());
      else if (t.startsWith('⚠️') || t.startsWith('⚠')) current.warnings.push(t.replace(/⚠️?/, '').trim());
      else if (t.startsWith('✅'))                       current.passed.push(t.replace('✅', '').trim());
    }
  }
  if (current) eventos.push(current);
  return eventos;
}

function parseInconsistencias(text) {
  const inconsistencias = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('Produto:') && line.includes('item_id:')) {
      const matchProduto = line.match(/Produto:\s*"(.+?)"\s*\(item_id:\s*"(.+?)"\)/);
      let linhaCampo = '', linhaOrigem = '', linhaAtual = '';
      let j = i + 1, count = 0;
      while (j < lines.length && count < 3) {
        const l = lines[j].trim();
        if (l) { if (count === 0) linhaCampo = l; if (count === 1) linhaOrigem = l; if (count === 2) linhaAtual = l; count++; }
        j++;
      }
      const matchCampo  = linhaCampo.match(/Campo:\s*"(.+?)"/);
      const matchOrigem = linhaOrigem.match(/^(.+?):\s*"(.+?)"$/);
      const matchAtual  = linhaAtual.match(/^(.+?):\s*"(.+?)"$/);
      if (matchProduto && matchCampo && matchOrigem && matchAtual) {
        inconsistencias.push({
          item_name: matchProduto[1], item_id: matchProduto[2],
          campo: matchCampo[1],
          evento_origem: matchOrigem[1].trim(), valor_origem: matchOrigem[2],
          evento_atual: matchAtual[1].trim(), valor_atual: matchAtual[2],
        });
      }
    }
  }
  return inconsistencias;
}

function extraiGA4(text) {
  const ga4Events = [];
  const lines     = text.split('\n');

  for (const line of lines) {
    const match = line.match(/\[GA4-(\d+)\]##(.+)/);
    if (match) {
      try { ga4Events.push({ index: parseInt(match[1]), event_name: JSON.parse(match[2].trim()).event_name, data: JSON.parse(match[2].trim()) }); } catch {}
    }
  }

  if (ga4Events.length === 0) {
    let current = null, jsonBuffer = '', emGA4 = false;
    for (const line of lines) {
      if (line.includes('EVENTOS GA4 CAPTURADOS')) { emGA4 = true; continue; }
      if (line.includes('COMPARAÇÃO DATALAYER'))   { emGA4 = false; break; }
      if (!emGA4) continue;
      const match = line.match(/\[GA4-(\d+)\] (.+)/);
      if (match) {
        if (current && jsonBuffer) { try { current.data = JSON.parse(jsonBuffer); } catch {} ga4Events.push(current); }
        current = { index: parseInt(match[1]), event_name: match[2].trim() }; jsonBuffer = '';
      } else if (current && line.trim() && !line.includes('Total GA4:')) { jsonBuffer += line; }
    }
    if (current && jsonBuffer) { try { current.data = JSON.parse(jsonBuffer); } catch {} ga4Events.push(current); }
  }

  return ga4Events;
}

function extraiComparacao(text) {
  const comparacoes = [];
  const lines       = text.split('\n');
  let emCmp = false, current = null;

  for (const line of lines) {
    if (line.includes('COMPARAÇÃO DATALAYER vs GA4')) { emCmp = true; continue; }
    if (!emCmp) continue;
    if (line.includes('COMPARAÇÃO:') && (line.includes('ok') || line.includes('divergê'))) break;

    const match = line.match(/\[CMP\] (✅|⚠️|🚫) (.+?)(?:\s+→\s+GA4:\s+(.+))?$/);
    if (match) {
      if (current) comparacoes.push(current);
      current = {
        status:       match[1] === '✅' ? 'ok' : match[1] === '🚫' ? 'nao_chegou_ga4' : 'divergencias',
        dlEvent:      match[2].trim(),
        ga4Event:     match[3]?.trim() ?? null,
        divergencias: []
      };
    } else if (current && line.trim() && !line.includes('[CMP]') && !line.includes('=====')) {
      const msg = line.trim();
      if (msg && !msg.startsWith('=')) current.divergencias.push(msg);
    }
  }
  if (current) comparacoes.push(current);
  return comparacoes;
}

// ─── ROTAS GET MOBILE (devem ficar antes do catch-all do dashboard) ───────────

app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, 'mobile', 'dashboard.html'));
});

const MOBILE_BRANDS = [
  { id: 'nv',        name: 'NV' },
  { id: 'marca-f',   name: 'Marca F' },
  { id: 'marca-a',   name: 'marca-a' },
  { id: 'marca-h', name: 'Marca H' },
  { id: 'marca-i',name: 'Marca I' },
  { id: 'marca-c',name: 'Marca C' },
  { id: 'marca-j',   name: 'marca-j' },
];

// ─── SAÚDE DO TRACKING — agrega todas as sessões de uma marca ────────────────

// ─── OVERVIEW: SAÚDE DE TODAS AS MARCAS (baseado na sessão de saúde de cada marca) ──
// Remove acentos antes de comparar — sem isso, região do schema ("Área Logada")
// nunca bate com o valor real do evento ("area-logada"), gerando falso "ausente".
const REGEX_MARCAS_COMBINACAO_APP = new RegExp('[' + String.fromCodePoint(0x300) + '-' + String.fromCodePoint(0x36f) + ']', 'g');
function removerAcentosApp(s) {
  return s.normalize('NFD').replace(REGEX_MARCAS_COMBINACAO_APP, '');
}
function normalizarRegiaoOverviewApp(r) {
  if (!r) return null;
  return removerAcentosApp(r.toLowerCase()).replace('todas as paginas', 'all').replace(/[-\s]/g, '').trim();
}
function extrairRegionEventoOverviewApp(dl) {
  const ev  = dl.event ?? dl;
  const eco = ev.ecommerce ?? {};
  const r = eco.region ?? ev.region ?? null;
  return r ? String(r).toLowerCase().trim() : null;
}

// Interpreta path de parâmetro no formato "chave[].campo" (ex.: "items[].item_id",
// "shippings[].shipping_tier") — genérico o bastante pra qualquer array aninhado do schema.
function resolverArrayParamApp(path) {
  const m = path && path.match(/^(\w+)\[\]\.(.+)$/);
  return m ? { arrayKey: m[1], campo: m[2] } : null;
}

// Calcula score de saúde de uma sessão vs schema (mesma lógica de /api/health-session)
// Normaliza ga4Events de sessão de app para o formato dl-like que os
// endpoints de saúde esperam — sem modificar nenhuma outra lógica existente.
// Para sessões web, retorna dlEvents diretamente (comportamento original).
function resolverDlEventsApp(sessao) {
  if (sessao.ambiente !== 'app') return sessao.dlEvents ?? [];
  return (sessao.ga4Events ?? []).map(ev => {
    const params = { ...(ev.params ?? {}) };
    // Alguns arrays (ex.: "shippings") chegam da captura como string JSON em vez
    // de array de verdade — faz parse pra permitir checagem de parâmetros aninhados.
    for (const key of Object.keys(params)) {
      const val = params[key];
      if (typeof val === 'string' && /^\s*\[/.test(val)) {
        try { params[key] = JSON.parse(val); } catch {}
      }
    }
    return {
      event: {
        event: ev.event_name,
        ...params,
        // items precisa estar tanto em items quanto em ecommerce.items
        ...(params.items ? { ecommerce: { items: params.items } } : {}),
      },
      timestamp: ev.timestamp ?? Date.now(),
      _fromMobile: true,
    };
  });
}

// Conta quantos campos ficariam de erro pra um único disparo (mesma regra do
// loop de validação abaixo, mas sem side-effects) — usado só pra comparar
// disparos duplicados do mesmo evento e escolher o mais completo como referência.
function contarErrosDisparoApp(dl, schemaEv, nome) {
  const ev  = dl.event ?? dl;
  const eco = ev.ecommerce ?? ev;
  const regionReal = eco.region ?? ev.region ?? null;
  let count = 0;
  for (const param of schemaEv.parameters ?? []) {
    const arrInfo = param.path ? resolverArrayParamApp(param.path) : null;
    const nomePar = param.name;
    if (param.required === false) continue;
    if (arrInfo) {
      const arr = asArray(eco[arrInfo.arrayKey] ?? ev[arrInfo.arrayKey]);
      if (!arr.length) {
        if (!EVENTOS_SEM_ITEMS_GLOBAL.has(nome)) count++;
      } else {
        arr.forEach(item => { const val = item?.[arrInfo.campo]; if (val === undefined || val === null || val === '') count++; });
      }
    } else {
      if (nomePar === 'items' && EVENTOS_SEM_ITEMS_GLOBAL.has(nome)) continue;
      const items0 = (eco.items ?? ev.items ?? [])[0] ?? {};
      const val    = eco[nomePar] ?? ev[nomePar] ?? items0[nomePar];
      if (val === undefined || val === null || val === '') count++;
    }
  }
  if (!regionReal) count++;
  return count;
}

function calcularScoreSessaoApp(sessao, schema, modo = 'parametros') {
  // modo = 'disparos':   correto = evento disparou (independente de parâmetros)
  // modo = 'parametros': correto = evento disparou E todos os parâmetros ok (comportamento original)
  const dlEvents = resolverDlEventsApp(sessao);
  const marca    = sessao.marca ?? null;
  const ambiente = sessao.ambiente ?? 'web';

  // Seleciona campo de marcas conforme plataforma da sessão
  const campoMarcas = ambiente === 'app' ? 'marcas_app' : 'marcas_site';

  // Filtra apenas eventos aplicáveis à plataforma e marca desta sessão
  const eventosAplicaveis = schema.events.filter(ev => {
    const marcasPlat = ev[campoMarcas] ?? [];
    if (!marcasPlat.length) return false; // evento não existe nessa plataforma
    if (!marca) return true;
    return marcasPlat.includes(marca);
  });

  const resultado = eventosAplicaveis.map(schemaEv => {
    const nome       = schemaEv.event;
    const regiao     = schemaEv.regiao;
    const regiaoNorm = normalizarRegiaoOverviewApp(regiao);
    const isTodas    = regiaoNorm === 'all' || regiaoNorm === 'todasaspaginas';

    const ocorrencias = dlEvents.filter(dl => {
      const ev = dl.event ?? dl;
      const evNome = ev.event ?? ev.event_name ?? '';
      const evNomeNorm = evNome.startsWith('custom_') ? evNome.replace('custom_', '') : evNome;
      const nomeMatch = (evNome === nome) || (evNomeNorm === nome);
      if (!nomeMatch) return false;
      if (isTodas) return true;
      if (regiaoNorm) {
        const regionEvento = extrairRegionEventoOverviewApp(dl);
        if (!regionEvento) return true;
        return normalizarRegiaoOverviewApp(regionEvento) === regiaoNorm;
      }
      return true;
    });

    // Eventos em EVENTOS_IGNORAR_SEMPRE_GLOBAL (ex.: "error") ausentes são esperados —
    // não conta como checkpoint ausente, fica de fora do total.
    if (ocorrencias.length === 0) {
      // ehOpcionalApp: lista PRÓPRIA do App (eventos-opcionais.js). Antes daqui o score do App
      // honrava só EVENTOS_IGNORAR_SEMPRE_GLOBAL, e por isso o select_promotion::PDC que saiu da
      // cobrança do Web em 27/10 seguia sendo cobrado no App. Não reusa as listas do Web de
      // propósito: uma delas espelha "Marcas SITE" do Notion e a outra isenta select_content na
      // Home, que no app dispara de verdade.
      if (EVENTOS_IGNORAR_SEMPRE_GLOBAL.has(nome) || ehOpcionalApp(marca, nome, regiao)) return { evento: nome, regiao, status: 'ausente', cobertura: 0, paramsErrados: [], ignorarNoTotal: true };
      return { evento: nome, regiao, status: 'ausente', cobertura: 0, paramsErrados: [] };
    }

    // Peso reduzido para o evento "error"
    const peso = nome === 'error' ? 0.5 : 1;

    // "purchase" pode disparar mais de uma vez na mesma sessão (retry/reload) —
    // usa o disparo mais completo (menos campos faltando) como referência única,
    // em vez de unir erros de todos os disparos.
    let ocorrenciasRef = ocorrencias;
    if (nome === 'purchase' && ocorrencias.length > 1) {
      let melhor = ocorrencias[0];
      let melhorCount = contarErrosDisparoApp(melhor, schemaEv, nome);
      for (const dl of ocorrencias.slice(1)) {
        const c = contarErrosDisparoApp(dl, schemaEv, nome);
        if (c < melhorCount) { melhor = dl; melhorCount = c; }
      }
      ocorrenciasRef = [melhor];
    }

    // No modo 'disparos': evento que disparou = correto, mas ainda calcula
    // erros de parâmetros para exibir como ponto de atenção no dashboard.
    if (modo === 'disparos') {
      const errosSet = new Set();
      for (const dl of ocorrenciasRef) {
        const ev  = dl.event ?? dl;
        const eco = ev.ecommerce ?? ev;
        const regionReal = eco.region ?? ev.region ?? null;
        for (const param of schemaEv.parameters ?? []) {
          const arrInfo = param.path ? resolverArrayParamApp(param.path) : null;
          const nomePar = param.name;
          if (param.required === false) continue; // respeita required:false do schema
          if (arrInfo) {
            const arr = asArray(eco[arrInfo.arrayKey] ?? ev[arrInfo.arrayKey]);
            // Eventos com items[] opcional (ex.: view_promotion/select_promotion sem produto
            // vinculado): array vazio não é erro, mas se vier com dados, valida normalmente.
            if (!arr.length) {
              if (!EVENTOS_SEM_ITEMS_GLOBAL.has(nome)) errosSet.add(nomePar);
            } else {
              arr.forEach(item => { const val = item?.[arrInfo.campo]; if (val === undefined || val === null || val === '') errosSet.add(nomePar); });
            }
          } else {
            if (nomePar === 'items' && EVENTOS_SEM_ITEMS_GLOBAL.has(nome)) continue;
            const items0 = (eco.items ?? ev.items ?? [])[0] ?? {};
            const val    = eco[nomePar] ?? ev[nomePar] ?? items0[nomePar];
            if (val === undefined || val === null || val === '') errosSet.add(nomePar);
          }
        }
        if (!regionReal) errosSet.add('region');
      }
      return { evento: nome, regiao, status: 'correto', cobertura: 100, paramsErrados: [...errosSet], totalParams: (schemaEv.parameters ?? []).length, peso, ignorarNoTotal: EVENTOS_IGNORAR_SEMPRE_GLOBAL.has(nome) };
    }

    // Modo 'parametros': valida parâmetros (comportamento original)
    const errosSet = new Set();
    for (const dl of ocorrenciasRef) {
      const ev  = dl.event ?? dl;
      const eco = ev.ecommerce ?? ev;
      const regionReal = eco.region ?? ev.region ?? null;

      for (const param of schemaEv.parameters ?? []) {
        const arrInfo = param.path ? resolverArrayParamApp(param.path) : null;
        const nomePar = param.name;
        if (param.required === false) continue; // respeita required:false do schema
        if (arrInfo) {
          const arr = asArray(eco[arrInfo.arrayKey] ?? ev[arrInfo.arrayKey]);
          // Eventos com items[] opcional (ex.: view_promotion/select_promotion sem produto
          // vinculado): array vazio não é erro, mas se vier com dados, valida normalmente.
          if (!arr.length) {
            if (!EVENTOS_SEM_ITEMS_GLOBAL.has(nome)) errosSet.add(nomePar);
          } else {
            arr.forEach(item => { const val = item?.[arrInfo.campo]; if (val === undefined || val === null || val === '') errosSet.add(nomePar); });
          }
        } else {
          const items0 = (eco.items ?? ev.items ?? [])[0] ?? {};
          const val    = eco[nomePar] ?? ev[nomePar] ?? items0[nomePar];
          if (val === undefined || val === null || val === '') errosSet.add(nomePar);
        }
      }
      if (!regionReal) errosSet.add('region');
    }
    const totalParams = (schemaEv.parameters ?? []).length || 1;
    const cobertura = Math.max(0, Math.round((1 - errosSet.size / totalParams) * 100));
    return { evento: nome, regiao, status: errosSet.size === 0 ? 'correto' : 'erro', cobertura, paramsErrados: [...errosSet], totalParams, peso, ignorarNoTotal: EVENTOS_IGNORAR_SEMPRE_GLOBAL.has(nome) };
  });

  // Exclui do total checkpoints marcados ignorarNoTotal (ex.: "error" ausente)
  const contaveis = resultado.filter(r => !r.ignorarNoTotal);
  const total    = contaveis.reduce((s, r) => s + (r.peso ?? 1), 0);
  const corretos = contaveis.filter(r => r.status === 'correto').reduce((s, r) => s + (r.peso ?? 1), 0);
  const erros    = contaveis.filter(r => r.status === 'erro').length;
  const ausentes = contaveis.filter(r => r.status === 'ausente').length;
  const score    = total > 0 ? Math.round((corretos / total) * 100) : 0;

  // Cobertura por parâmetro (agrega params do schema, únicos por nome, só conta eventos que dispararam)
  const paramMap = {};
  schema.events.forEach(schemaEv => {
    const r = resultado.find(x => x.evento === schemaEv.event && x.regiao === schemaEv.regiao);
    if (!r || r.status === 'ausente') return;
    (schemaEv.parameters ?? []).forEach(param => {
      const pname = param.name;
      if (!paramMap[pname]) paramMap[pname] = { name: pname, total: 0, ok: 0 };
      paramMap[pname].total++;
      if (!r.paramsErrados.includes(pname)) paramMap[pname].ok++;
    });
  });
  const parametros = Object.values(paramMap).map(p => ({ name: p.name, cobertura: p.total > 0 ? Math.round((p.ok/p.total)*100) : 0, total: p.total }));

  // Mesma agregação acima, mas restrita aos eventos principais — usada pela coluna
  // "Parâmetros" do dashboard quando o filtro está em "Eventos principais", em vez
  // da cobertura de todos os eventos do schema (que fica sempre em "parametros").
  const paramMapPrincipais = {};
  schema.events.forEach(schemaEv => {
    if (!isEventoPrincipalGlobal(schemaEv)) return;
    const r = resultado.find(x => x.evento === schemaEv.event && x.regiao === schemaEv.regiao);
    if (!r || r.status === 'ausente') return;
    (schemaEv.parameters ?? []).forEach(param => {
      const pname = param.name;
      if (!paramMapPrincipais[pname]) paramMapPrincipais[pname] = { name: pname, total: 0, ok: 0 };
      paramMapPrincipais[pname].total++;
      if (!r.paramsErrados.includes(pname)) paramMapPrincipais[pname].ok++;
    });
  });
  const parametrosPrincipais = Object.values(paramMapPrincipais).map(p => ({ name: p.name, cobertura: p.total > 0 ? Math.round((p.ok/p.total)*100) : 0, total: p.total }));

  // session_start não está no schema (não faz sentido documentar parâmetros pra ele —
  // é o evento padrão de início de sessão do Firebase, sem tela associada), mas toda
  // jornada usada como referência de saúde deve tê-lo disparado. Mostra só presença,
  // sem entrar na conta de score/total do schema (fica de fora de "corretos"/"total" acima).
  let eventos = resultado;
  if (ambiente === 'app') {
    const temSessionStart = dlEvents.some(dl => {
      const ev = dl.event ?? dl;
      return (ev.event ?? ev.event_name) === 'session_start';
    });
    eventos = [...resultado, {
      evento: 'session_start', regiao: null,
      status: temSessionStart ? 'correto' : 'ausente',
      cobertura: temSessionStart ? 100 : 0,
      paramsErrados: [],
    }];
  }

  return { score, corretos, erros, ausentes, total, eventos, parametros, parametrosPrincipais };
}

// Saúde do App usa validação própria e isolada: coverage-schema.json e
// calcularScoreSessaoApp (cópia exclusiva do App, com fix de acento e tudo mais)
// — nada aqui é compartilhado com o schema.json/calcularScoreSessao do Web.
function escolherSessaoSaudeApp(sessoesApp) {
  const elegiveis = sessoesApp.filter(s => s.pasta === 'Produção');
  if (!elegiveis.length) return null;
  return elegiveis.reduce((mais, atual) => (atual.timestamp > mais.timestamp ? atual : mais));
}

app.get('/api/app-health/overview', async (req, res) => {
  let schema;
  const schemaLocal = path.join(__dirname, 'mobile', 'coverage-schema.json');
  try {
    if (fs.existsSync(schemaLocal)) {
      schema = JSON.parse(fs.readFileSync(schemaLocal));
    }
  } catch {}
  if (!schema) return res.json({ mediaGeral: 0, totalEventos: 0, marcas: [] });

  const marcasHealth = await Promise.all(MOBILE_BRANDS.map(async ({ id: marca }) => {
    // 1. Sessão de referência = mais recente com pasta "Produção" (automático, sem marcação manual)
    const sessoesApp = await getMobileSessions(marca);
    const sessao = escolherSessaoSaudeApp(sessoesApp);
    if (!sessao) return { marca, pct: 0, adequados: 0, atencao: 0, criticos: 0, total: 0, semSessao: true };

    // 2. Calcula score (função exclusiva do App)
    const modo = 'disparos';
    const { score, corretos, erros, ausentes, total, eventos, parametros, parametrosPrincipais } = calcularScoreSessaoApp(sessao, schema, modo);
    return { marca, pct: score, adequados: corretos, atencao: 0, criticos: erros, ausentes, total, sessaoNome: sessao.nome, sessionId: sessao.sessionId, appVersion: sessao.appVersion || null, eventos, parametros, parametrosPrincipais };
  }));

  const validas    = marcasHealth.filter(m => !m.semSessao);
  const mediaGeral = validas.length > 0 ? Math.round(validas.reduce((s, m) => s + m.pct, 0) / validas.length) : 0;
  const totalEvs = schema.events.filter(e => (e.marcas_app ?? []).length > 0).length;

  const EVENTOS_COM_QUEBRA_REGIAO = ['view_item_list'];
  const eventoAgg = {};
  for (const m of validas) {
    for (const e of m.eventos ?? []) {
      if (e.status === 'ausente') continue;
      const quebra = EVENTOS_COM_QUEBRA_REGIAO.includes(e.evento);
      const key    = quebra ? e.evento + '::' + (e.regiao ?? '') : e.evento;
      if (!eventoAgg[key]) eventoAgg[key] = { evento: e.evento, regiao: quebra ? e.regiao : null, somaCobertura: 0, marcas: 0 };
      eventoAgg[key].somaCobertura += e.cobertura;
      eventoAgg[key].marcas++;
    }
  }
  const eventosAgregados = Object.values(eventoAgg).map(e => ({
    evento: e.evento, regiao: e.regiao, cobertura: Math.round(e.somaCobertura / e.marcas), marcas: e.marcas,
  }));

  const paramAgg = {};
  for (const m of validas) {
    for (const p of m.parametros ?? []) {
      if (!paramAgg[p.name]) paramAgg[p.name] = { name: p.name, somaCobertura: 0, marcas: 0 };
      paramAgg[p.name].somaCobertura += p.cobertura;
      paramAgg[p.name].marcas++;
    }
  }
  const parametrosAgregados = Object.values(paramAgg)
    .map(p => ({ name: p.name, cobertura: Math.round(p.somaCobertura / p.marcas), marcas: p.marcas }))
    .sort((a, b) => a.cobertura - b.cobertura);

  res.json({ mediaGeral, totalEventos: totalEvs, marcas: marcasHealth, eventosAgregados, parametrosAgregados });
});

// Sessões mobile só ficam garantidas no GitHub (commit em /api/mobile/session/stop) —
// o disco local é efêmero por instância no Cloud Run, então toda leitura precisa cair
// pro GitHub quando o disco local não tiver o dado (instância nova, cold start, etc.).
async function listMobileSessionFilesGitHub(marca) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !repo) return [];
  try {
    const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
    const resp = await fetch(`https://api.github.com/repos/${repo}/contents/sessions/mobile/${marca}?ref=${branch}`, { headers });
    if (!resp.ok) return [];
    const files = await resp.json();
    return Array.isArray(files) ? files.filter(f => f.name.endsWith('.json')) : [];
  } catch {
    return [];
  }
}

// Combina dois formatos de sessão mobile: o histórico anterior à unificação
// (sessions/mobile/{marca}/, formato próprio do Faro App) e o formato atual
// (sessions/{marca}/ com ambiente:"app", compatível com a área de saúde oficial).
//
// Sempre combina disco local + GitHub (nunca só um ou outro): o disco do
// Cloud Run é por instância, então uma instância pode ter só parte das
// sessões no disco (as que ela mesma processou) enquanto o GitHub tem o
// histórico completo. Usar "se existe local, ignora GitHub" fazia a
// listagem variar dependendo de qual instância atendia a requisição.
//
// Cache em memória por marca: cada sessão listada custa 1 chamada à API do
// GitHub pra baixar o conteúdo, então uma marca com muitas sessões (ou várias
// pessoas navegando ao mesmo tempo) pode facilmente estourar a cota horária.
//
// 10 minutos, não 30 segundos. Com 30s o cache expirava junto com o polling do
// dashboard e quase toda atualização pagava o preço cheio: 35 downloads por
// listagem da Marca F, 120 vezes por hora, 4.200 chamadas só de uma aba aberta.
// O risco de dado velho está coberto pela invalidação em toda escrita (middleware
// logo após o express.json), então o TTL só serve como rede de segurança para
// mudança feita fora deste processo — outra instância do Cloud Run, ou commit
// direto no GitHub.
const _mobileSessionsCache = new Map();
async function getMobileSessions(marca) {
  const cacheKey = marca;
  const cached   = _mobileSessionsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const data = await getMobileSessionsUncached(marca);
  _mobileSessionsCache.set(cacheKey, { data, expiresAt: Date.now() + 600_000 });
  return data;
}

async function getMobileSessionsUncached(marca) {
  const token   = process.env.GITHUB_TOKEN;
  const repo    = process.env.GITHUB_REPO;
  const branch  = process.env.GITHUB_BRANCH || 'main';
  const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
  const bySessionId = new Map();
  const add = (data) => { if (data?.sessionId && !bySessionId.has(data.sessionId)) bySessionId.set(data.sessionId, data); };

  // 1) Formato atual: sessions/{marca}/ filtrando ambiente:"app"
  const newDir = path.join(__dirname, 'sessions', marca);
  if (fs.existsSync(newDir)) {
    for (const f of fs.readdirSync(newDir).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(newDir, f), 'utf8'));
        if (data.ambiente === 'app') add(data);
      } catch {}
    }
  }
  if (token && repo) {
    try {
      const resp = await fetch(`https://api.github.com/repos/${repo}/contents/sessions/${marca}?ref=${branch}`, { headers });
      if (resp.ok) {
        const files = await resp.json();
        const downloaded = await Promise.all(
          (Array.isArray(files) ? files : []).filter(f => f.name.endsWith('.json')).map(async f => {
            try { const r = await fetch(f.download_url, { headers }); return r.ok ? await r.json() : null; } catch { return null; }
          })
        );
        downloaded.filter(Boolean).forEach(d => { if (d.ambiente === 'app') add(d); });
      }
    } catch {}
  }

  // 2) Histórico anterior à unificação: sessions/mobile/{marca}/
  const legacyDir = path.join(__dirname, 'sessions', 'mobile', marca);
  if (fs.existsSync(legacyDir)) {
    for (const f of fs.readdirSync(legacyDir).filter(f => f.endsWith('.json'))) {
      try { add(JSON.parse(fs.readFileSync(path.join(legacyDir, f), 'utf8'))); } catch {}
    }
  }
  {
    const files = await listMobileSessionFilesGitHub(marca);
    const downloaded = await Promise.all(files.map(async f => {
      try { const r = await fetch(f.download_url, { headers }); return r.ok ? await r.json() : null; } catch { return null; }
    }));
    downloaded.filter(Boolean).forEach(add);
  }

  return [...bySessionId.values()];
}

app.get('/api/mobile/brands', async (req, res) => {
  const brands = await Promise.all(MOBILE_BRANDS.map(async b => {
    const count = (await getMobileSessions(b.id)).length;
    return { ...b, sessionCount: count };
  }));
  res.json(brands);
});

app.get('/api/mobile/sessions', async (req, res) => {
  const sessions = [];
  for (const b of MOBILE_BRANDS) {
    const marcaSessions = await getMobileSessions(b.id);
    for (const content of marcaSessions) {
      // Formato antigo (histórico): resumo em content.summary
      // Formato atual (unificado): resumo próprio em content._summaryFaroApp
      const summary = content?.summary ?? content?._summaryFaroApp;
      if (!summary) continue;
      sessions.push({
        sessionId: content.sessionId,
        marca: content.marca,
        timestamp: content.timestamp,
        nome: content.nome || null,
        pasta: content.pasta || null,
        status: summary.validationErrors > 0 ? 'has_errors' : 'ok',
        validationErrors: summary.validationErrors,
        hasInconsistencies: summary.hasInconsistencies,
        totalEvents: summary.totalEvents,
      });
    }
  }
  sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(sessions);
});

// MESMA LISTAGEM, DE UMA MARCA SÓ — e por que ela precisa existir.
//
// A rota acima varre as 7 marcas. O contêiner não guarda sessão em disco (o Dockerfile não
// copia `sessions/`), então cada sessão listada é um download da API do GitHub: 111 chamadas
// por execução, em 29/10/2026. O dashboard do App chamava justamente ela a cada 4 segundos e
// filtrava a marca no navegador — 120 renovações de cache por hora × 111 = 13.320 chamadas,
// contra uma cota de 5.000/hora. Estourada a cota, o GitHub responde 403, o `catch` devolve
// lista vazia em silêncio, e o Cloud Run passa a recusar com 429. Era o "Erro ao contatar
// servidor / HTTP 429" que aparecia no painel de Captura ADB.
//
// Pedindo uma marca só, o pior caso (Marca F, 35 sessões) custa um terço, e a maioria custa
// menos de 10% do que custava.
app.get('/api/mobile/sessions/:marca', async (req, res, next) => {
  // `active` é outra rota, declarada mais abaixo, e tem um segmento só como esta aqui —
  // sem este desvio ela nunca seria alcançada, porque o Express casa na ordem de registro.
  if (req.params.marca === 'active') return next();

  const marcaSessions = await getMobileSessions(req.params.marca);
  const sessions = [];
  for (const content of marcaSessions) {
    const summary = content?.summary ?? content?._summaryFaroApp;
    if (!summary) continue;
    sessions.push({
      sessionId: content.sessionId,
      marca: content.marca,
      timestamp: content.timestamp,
      nome: content.nome || null,
      pasta: content.pasta || null,
      status: summary.validationErrors > 0 ? 'has_errors' : 'ok',
      validationErrors: summary.validationErrors,
      hasInconsistencies: summary.hasInconsistencies,
      totalEvents: summary.totalEvents,
    });
  }
  sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(sessions);
});

// Pastas do Faro App — isolado do esquema de pastas do Faro Web (que varre
// sessions/{marca}/ sem filtrar ambiente). Aqui só entram sessões com
// ambiente:"app" e as legadas em sessions/mobile/{marca}/, que já são
// exclusivas do app.
app.get('/api/mobile/folders/:marca', async (req, res) => {
  const { marca } = req.params;
  const sessions = await getMobileSessions(marca);
  const pastas = new Set();
  sessions.forEach(s => { if (s.pasta) pastas.add(s.pasta); });
  res.json([...pastas].sort());
});

// Renomeia uma pasta em lote — todas as sessões do app (marca) com o valor
// atual de pasta passam a ter o novo valor, numa chamada só. Sessões web
// nunca são tocadas: essa função só lê a partir de getMobileSessions, que já
// filtra por ambiente:"app" (+ legado, que é sempre do app).
app.patch('/api/mobile/folders/:marca/:pastaAtual', async (req, res) => {
  const { marca, pastaAtual } = req.params;
  const { novoNome } = req.body;
  if (typeof novoNome !== 'string' || !novoNome.trim()) return res.status(400).json({ error: 'novoNome obrigatório' });
  const nome = novoNome.trim();

  const sessions = await getMobileSessions(marca);
  const alvo = sessions.filter(s => s.pasta === pastaAtual);
  if (!alvo.length) return res.status(404).json({ error: 'Pasta não encontrada' });

  let renomeadas = 0;
  for (const sessao of alvo) {
    sessao.pasta = nome;
    const fileContent = JSON.stringify(sessao, null, 2);
    const isNovoFormato = sessao.ambiente === 'app';
    const remotePath = isNovoFormato
      ? `sessions/${marca}/${sessao.sessionId}.json`
      : `sessions/mobile/${marca}/${sessao.sessionId}.json`;
    const localPath = isNovoFormato
      ? path.join(__dirname, 'sessions', marca, `${sessao.sessionId}.json`)
      : path.join(__dirname, 'sessions', 'mobile', marca, `${sessao.sessionId}.json`);

    if (fs.existsSync(localPath)) {
      try { fs.writeFileSync(localPath, fileContent); } catch {}
    }
    try {
      await commitToGitHub(remotePath, fileContent, `pasta: renomeia "${pastaAtual}" -> "${nome}" (${sessao.sessionId})`);
      renomeadas++;
    } catch (e) {
      console.error('Erro ao renomear pasta (commit):', sessao.sessionId, e.message);
    }
  }

  res.json({ ok: true, pasta: nome, sessoesAtualizadas: renomeadas, sessoesTotal: alvo.length });
});

// Resolve o caminho local de uma sessão mobile — tenta o formato atual
// (sessions/{marca}/{sessionId}.json, marcado ambiente:"app") e cai pro
// formato antigo (sessions/mobile/{marca}/{sessionId}.json) se não achar.
function resolveMobileSessionLocalPath(marca, sessionId) {
  const newPath = path.join(__dirname, 'sessions', marca, `${sessionId}.json`);
  if (fs.existsSync(newPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(newPath, 'utf8'));
      if (data.ambiente === 'app') return newPath;
    } catch {}
  }
  const legacyPath = path.join(__dirname, 'sessions', 'mobile', marca, `${sessionId}.json`);
  if (fs.existsSync(legacyPath)) return legacyPath;
  return null;
}

// Mesma resolução, buscando no GitHub quando não existe local — tenta os
// dois caminhos possíveis (atual e legado) já que não dá pra saber qual é
// sem checar.
async function fetchMobileSessionFromGithub(marca, sessionId) {
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !repo) return null;
  const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests' };
  for (const remotePath of [`sessions/${marca}/${sessionId}.json`, `sessions/mobile/${marca}/${sessionId}.json`]) {
    try {
      const resp = await fetch(`https://api.github.com/repos/${repo}/contents/${remotePath}?ref=${branch}`, { headers });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.content) return { content: JSON.parse(Buffer.from(data.content, 'base64').toString()), remotePath, sha: data.sha };
      if (data.download_url) {
        const dl = await fetch(data.download_url, { headers });
        if (dl.ok) return { content: await dl.json(), remotePath, sha: data.sha };
      }
    } catch {}
  }
  return null;
}

app.get('/api/mobile/sessions/:marca/:sessionId', async (req, res) => {
  const { marca, sessionId } = req.params;
  const filePath = resolveMobileSessionLocalPath(marca, sessionId);
  if (filePath) {
    try {
      return res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch {
      return res.status(500).json({ error: 'Erro ao ler sessão' });
    }
  }

  const found = await fetchMobileSessionFromGithub(marca, sessionId);
  if (!found) return res.status(404).json({ error: 'Sessão não encontrada' });
  res.json(found.content);
});

app.delete('/api/mobile/sessions/:marca/:sessionId', async (req, res) => {
  const { marca, sessionId } = req.params;
  const filePath = resolveMobileSessionLocalPath(marca, sessionId);
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch {
      return res.status(500).json({ error: 'Erro ao excluir sessão' });
    }
  }

  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;
  if (token && repo) {
    for (const remotePath of [`sessions/${marca}/${sessionId}.json`, `sessions/mobile/${marca}/${sessionId}.json`]) {
      try {
        const baseUrl = `https://api.github.com/repos/${repo}/contents/${remotePath}`;
        const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': 'tracking-tests', 'Content-Type': 'application/json' };
        const getResp = await fetch(baseUrl, { headers });
        if (getResp.ok) {
          const data = await getResp.json();
          await fetch(baseUrl, { method: 'DELETE', headers, body: JSON.stringify({ message: `chore: remove sessão mobile ${sessionId}`, sha: data.sha, branch: process.env.GITHUB_BRANCH || 'main' }) });
        }
      } catch {}
    }
  }
  res.json({ success: true });
});

app.patch('/api/mobile/sessions/:marca/:sessionId/rename', async (req, res) => {
  const { marca, sessionId } = req.params;
  const { nome } = req.body;
  if (typeof nome !== 'string') return res.status(400).json({ error: 'nome obrigatório' });

  let filePath = resolveMobileSessionLocalPath(marca, sessionId);
  let content;
  let remotePath = `sessions/${marca}/${sessionId}.json`;
  if (filePath) {
    try {
      content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      remotePath = filePath.includes(path.join('sessions', 'mobile'))
        ? `sessions/mobile/${marca}/${sessionId}.json`
        : `sessions/${marca}/${sessionId}.json`;
    } catch {
      return res.status(500).json({ error: 'Erro ao renomear sessão' });
    }
  } else {
    const found = await fetchMobileSessionFromGithub(marca, sessionId);
    if (!found) return res.status(404).json({ error: 'Sessão não encontrada' });
    content = found.content;
    remotePath = found.remotePath;
    filePath = path.join(__dirname, remotePath);
  }

  content.nome = nome.trim() || null;
  const fileContent = JSON.stringify(content, null, 2);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, fileContent);
  } catch {
    return res.status(500).json({ error: 'Erro ao renomear sessão' });
  }

  // Recommita no GitHub para não deixar a renomeação "atrasada" em relação ao
  // auto-commit original (mesmo problema documentado para sessões web).
  try {
    await commitToGitHub(remotePath, fileContent, `rename: ${sessionId} (${marca})`);
  } catch {}

  res.json({ success: true, nome: content.nome });
});

// Move uma sessão do app pra uma pasta (ou remove da pasta com pasta: null) —
// mesmo padrão do rename acima, isolado do endpoint de pasta do Faro Web.
app.patch('/api/mobile/sessions/:marca/:sessionId/pasta', async (req, res) => {
  const { marca, sessionId } = req.params;
  const { pasta } = req.body;

  let filePath = resolveMobileSessionLocalPath(marca, sessionId);
  let content;
  let remotePath = `sessions/${marca}/${sessionId}.json`;
  if (filePath) {
    try {
      content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      remotePath = filePath.includes(path.join('sessions', 'mobile'))
        ? `sessions/mobile/${marca}/${sessionId}.json`
        : `sessions/${marca}/${sessionId}.json`;
    } catch {
      return res.status(500).json({ error: 'Erro ao mover sessão' });
    }
  } else {
    const found = await fetchMobileSessionFromGithub(marca, sessionId);
    if (!found) return res.status(404).json({ error: 'Sessão não encontrada' });
    content = found.content;
    remotePath = found.remotePath;
    filePath = path.join(__dirname, remotePath);
  }

  content.pasta = (typeof pasta === 'string' && pasta.trim()) ? pasta.trim() : null;
  const fileContent = JSON.stringify(content, null, 2);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, fileContent);
  } catch {
    return res.status(500).json({ error: 'Erro ao mover sessão' });
  }

  try {
    await commitToGitHub(remotePath, fileContent, `pasta: move ${sessionId} para "${content.pasta ?? '(sem pasta)'}" (${marca})`);
  } catch {}

  res.json({ success: true, pasta: content.pasta });
});

const _mobileSchemaForExpand = require('./mobile/mobile-schema.json');
const _arrayEventParamsApp = new Set(
  Object.entries(_mobileSchemaForExpand.eventParamTypes || {})
    .filter(([, type]) => type === 'Array')
    .map(([key]) => key)
);

function expandJsonStringParamsApp(params) {
  const result = {};
  for (const [k, v] of Object.entries(params)) {
    if (_arrayEventParamsApp.has(k) && typeof v === 'string') {
      try {
        const p = JSON.parse(v);
        if (Array.isArray(p) && p.length > 0 && typeof p[0] === 'object') { result[k] = p; continue; }
      } catch {}
    }
    result[k] = v;
  }
  return result;
}

function gerarHTMLRelatorioMobile(sessao) {
  const s = sessao.summary || sessao._summaryFaroApp || {};
  const ga4Events = sessao.payload?.ga4Events ?? sessao.ga4Events ?? [];
  const dlEvents  = sessao.payload?.dlEvents  ?? sessao.dlEvents  ?? [];
  const parceiros = sessao.payload?.parceiros ?? sessao.parceiros ?? [];
  const inconsistencies = s.inconsistencies || [];
  const allEvents = [...ga4Events, ...dlEvents];
  const ts = sessao.timestamp ? new Date(sessao.timestamp).toLocaleString('pt-BR') : '—';

  const mobileSchema    = require('./mobile/mobile-schema.json');
  const schemaEventNames = Object.keys(mobileSchema.events);
  const coverageItems   = schemaEventNames.map(eventName => {
    const occs  = allEvents.filter(e => (e.event_name || e.event) === eventName);
    if (!occs.length) return { event: eventName, fired: false, count: 0, valid: null };
    const valid = occs.every(e => { const v = e._meta?.validation; return !v || v.skipped || v.valid; });
    return { event: eventName, fired: true, count: occs.length, valid };
  });
  const firedCount  = coverageItems.filter(c => c.fired).length;
  const coveragePct = Math.round((firedCount / schemaEventNames.length) * 100);

  function sourceLabel(meta) {
    if (!meta) return 'Desconhecido';
    const map = { fa_verbose: 'FA Verbose', flutter_debug: 'Flutter Debug', firebase_sdk: 'Firebase SDK', datalayer: 'DataLayer' };
    return map[meta.source] || 'Desconhecido';
  }

  function validationBadge(meta) {
    const v = meta?.validation;
    if (!v) return '<span class="badge badge-na">sem validação</span>';
    if (v.skipped) return '<span class="badge badge-na">sem params</span>';
    if (v.valid) return '<span class="badge badge-ok">válido</span>';
    return '<span class="badge badge-error">inválido</span>';
  }

  const eventsRows = allEvents.map((ev, i) => {
    const name   = ev.event_name || ev.event || '—';
    const meta   = ev._meta || {};
    const v      = meta.validation || {};
    const errors = v.errors || [];
    const errHtml = errors.length > 0
      ? `<ul class="err-list">${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`
      : '';
    const params = ev.params || ev.ecommerce || {};
    return `
      <tr>
        <td>${i + 1}</td>
        <td><strong>${esc(name)}</strong></td>
        <td>${esc(sourceLabel(meta))}</td>
        <td>${validationBadge(meta)}${errHtml}</td>
        <td><pre class="params">${esc(JSON.stringify(expandJsonStringParamsApp(params), null, 2))}</pre></td>
      </tr>`;
  }).join('');

  const coverageColor  = coveragePct >= 80 ? '#15803d' : coveragePct >= 50 ? '#d97706' : '#dc2626';
  const coverageBadges = coverageItems.map(c => {
    const cls   = !c.fired ? 'cov-missing' : c.valid ? 'cov-ok' : 'cov-error';
    const label = esc(c.event) + (c.fired ? ' \xd7' + c.count : '');
    return `<span class="cov-badge ${cls}">${label}</span>`;
  }).join('');
  const coverageSectionHtml = `<h2>Cobertura do Schema</h2>
<div style="margin-bottom:12px;font-size:13px;font-weight:700;color:${coverageColor}">${firedCount} de ${schemaEventNames.length} eventos dispararam — ${coveragePct}%</div>
<div class="coverage-grid">${coverageBadges}</div>
<div style="display:flex;gap:16px;margin-top:14px;margin-bottom:8px;font-size:11px;color:#94a3b8;align-items:center">
  <span style="display:flex;align-items:center;gap:5px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#15803d"></span>disparou e válido</span>
  <span style="display:flex;align-items:center;gap:5px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#dc2626"></span>disparou com erro</span>
  <span style="display:flex;align-items:center;gap:5px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#e2e8f0"></span>não disparou nesta sessão</span>
</div>`;

  // Consolidated schema errors
  const allErrorItems = [];
  allEvents.forEach(ev => {
    const evName = ev.event_name || ev.event || '—';
    (ev._meta?.validation?.errors || []).forEach(err => allErrorItems.push({ event: evName, err }));
  });
  const errorMap = {};
  allErrorItems.forEach(({ event, err }) => {
    if (!errorMap[err]) errorMap[err] = { count: 0, events: new Set() };
    errorMap[err].count++;
    errorMap[err].events.add(event);
  });
  const errorSummaryRows = Object.entries(errorMap)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([err, data]) => `
      <tr>
        <td><code>${esc(err)}</code></td>
        <td>${[...data.events].map(e => `<span class="ev-tag">${esc(e)}</span>`).join('')}</td>
        <td class="num">${data.count}</td>
      </tr>`).join('');
  const errorSummaryHtml = allErrorItems.length === 0 ? '' : `
    <h2>Erros de Schema (${allErrorItems.length} ocorr\xeancia${allErrorItems.length !== 1 ? 's' : ''})</h2>
    <table>
      <thead><tr><th>Erro</th><th>Eventos</th><th>Qtd</th></tr></thead>
      <tbody>${errorSummaryRows}</tbody>
    </table>`;

  // Grouped event detail
  const eventGroups = {};
  allEvents.forEach(ev => {
    const name = ev.event_name || ev.event || '—';
    if (!eventGroups[name]) eventGroups[name] = [];
    eventGroups[name].push(ev);
  });
  const groupedRows = Object.entries(eventGroups).map(([name, evs]) => {
    const total = evs.length;
    const withErrors = evs.filter(e => { const v = e._meta?.validation; return v && !v.skipped && !v.valid; }).length;
    const uniqueErrs = [...new Set(evs.flatMap(e => e._meta?.validation?.errors || []))];
    const statusBadge = withErrors === 0
      ? '<span class="badge badge-ok">OK</span>'
      : `<span class="badge badge-error">${withErrors}\xd7 erro</span>`;
    const errHtml = uniqueErrs.length > 0
      ? `<ul class="err-list">${uniqueErrs.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`
      : '—';
    return `<tr>
      <td><strong>${esc(name)}</strong></td>
      <td class="num">${total}</td>
      <td>${statusBadge}</td>
      <td>${errHtml}</td>
    </tr>`;
  }).join('');
  const groupedDetailHtml = `
    <h2>Detalhamento por Evento</h2>
    <table>
      <thead><tr><th>Evento</th><th>Disparos</th><th>Status</th><th>Erros \xfanicos</th></tr></thead>
      <tbody>${groupedRows}</tbody>
    </table>`;

  const catColors = { MMP: '#7c3aed', Pixel: '#1d4ed8', CRM: '#047857', Retargeting: '#b45309', Chat: '#0891b2' };
  const parceirosHtml = parceiros.length === 0 ? '' : `
    <h2>Parceiros detectados (${parceiros.length})</h2>
    <div class="partner-grid">
      ${parceiros.map(p => {
        const color = catColors[p.categoria] || '#374151';
        return `<span class="partner-badge" style="border-color:${color}">
          <span class="partner-dot" style="background:${color}"></span>
          <strong>${esc(p.nome)}</strong>
          <span class="partner-cat">${esc(p.categoria)}</span>
        </span>`;
      }).join('')}
    </div>`;

  const inconsistenciesHtml = inconsistencies.length === 0 ? '' : `
    <h2>Inconsistências</h2>
    <table>
      <thead><tr><th>item_id</th><th>Campo</th><th>Valores detectados</th></tr></thead>
      <tbody>
        ${inconsistencies.map(ic => `
          <tr>
            <td>${esc(ic.item_id)}</td>
            <td><code>${esc(ic.field)}</code></td>
            <td>${ic.values.map(v => `<span class="ic-tag">${esc(v.event)}</span> ${esc(String(v.value))}`).join('<br>')}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  // Pares view_promotion ↔ select_promotion — mesma comparação que o relatório web tem.
  const promotionPairs = (sessao.comparacao ?? []).filter(c => c.dlPar === 'view_promotion' && c.dlEvent === 'select_promotion');
  const promotionPairsHtml = promotionPairs.length === 0 ? '' : `
    <h2>Pares view_promotion ↔ select_promotion (${promotionPairs.length})</h2>
    <table>
      <thead><tr><th>Promoção</th><th>Status</th><th>Divergências</th></tr></thead>
      <tbody>
        ${promotionPairs.map(p => {
          const temDiv = p.divergencias?.length > 0;
          const slotDivergente = !!p.slotDivergeMasItemConfirmado;
          const correspondenciaFraca = !!p.correspondenciaFraca;
          const nota = slotDivergente
            ? 'É o mesmo item (promotion_name e creative_name batem), mas o <strong>creative_slot</strong> usa nomenclatura diferente entre o view e o select — provável inconsistência no site, não falta de dado.<br>'
            : correspondenciaFraca
              ? 'Não foi encontrado view_promotion com o mesmo creative_slot, e o creative_name também diverge do candidato mais próximo (só o promotion_name bateu) — não dá pra confirmar que é o mesmo item.<br>'
              : '';
          return `<tr>
            <td>${esc(p.promocao)}</td>
            <td>${temDiv ? '<span class="badge badge-error">divergências</span>' : '<span class="badge badge-ok">ok</span>'}</td>
            <td>${nota}${temDiv ? p.divergencias.map(d => esc(d)).join('<br>') : 'Parâmetros idênticos entre view e select'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Faro App — Relatório ${esc(sessao.sessionId)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 13px; color: #1e293b; margin: 0; padding: 28px 32px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
  h1 { font-size: 20px; color: #0f172a; margin: 0 0 5px; font-weight: 700; letter-spacing: -.02em; }
  .sub { font-size: 12px; color: #64748b; }
  .logo { font-size: 11px; color: #94a3b8; text-align: right; font-weight: 500; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 28px; }
  .card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 18px; text-align: center; box-shadow: 0 2px 8px rgba(15,23,42,.06); }
  .card .label { font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: .07em; margin-bottom: 6px; }
  .card .value { font-size: 28px; font-weight: 700; color: #0f172a; letter-spacing: -.02em; }
  .card.error .value { color: #dc2626; }
  .card.warn  .value { color: #d97706; }
  .card.ok    .value { color: #16a34a; }
  h2 { font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .07em; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin: 28px 0 14px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 28px; }
  th { font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .05em; padding: 7px 10px; border-bottom: 2px solid #e2e8f0; text-align: left; }
  td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; font-size: 12px; }
  .badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 20px; }
  .badge-ok    { background: #dcfce7; color: #15803d; }
  .badge-error { background: #fee2e2; color: #dc2626; }
  .badge-na    { background: #f1f5f9; color: #64748b; }
  .err-list { margin: 4px 0 0 0; padding-left: 14px; color: #dc2626; font-size: 11px; }
  .params { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 7px 10px; font-size: 11px; white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow: hidden; margin: 0; font-family: 'Cascadia Code', 'Fira Code', ui-monospace, monospace; }
  code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 11px; }
  .ic-tag { display: inline-block; background: #fde68a; color: #78350f; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; margin-right: 4px; }
  .coverage-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .cov-badge { padding: 5px 11px; border-radius: 6px; font-size: 11px; font-weight: 500; line-height: 1.4; }
  .cov-ok      { background: #dcfce7; color: #15803d; }
  .cov-error   { background: #fee2e2; color: #dc2626; }
  .cov-missing { background: #f1f5f9; color: #94a3b8; }
  .partner-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
  .partner-badge { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 5px 12px; font-size: 12px; background: #f9fafb; font-weight: 500; }
  .partner-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .partner-cat { font-size: 10px; color: #6b7280; margin-left: 2px; }
  .ev-tag { display: inline-block; background: #e0f2fe; color: #075985; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; margin: 1px 2px; }
  td.num { text-align: center; font-weight: 700; }
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>Faro App — Relatório de Sessão Mobile</h1>
    <div class="sub">Sessão: <strong>${esc(sessao.sessionId)}</strong> · Marca: <strong>${esc(sessao.marca)}</strong> · ${esc(ts)}</div>
  </div>
  <div class="logo">Grupo Soma · Faro App</div>
</div>

<div class="cards">
  <div class="card"><div class="label">Eventos</div><div class="value">${s.totalEvents || 0}</div></div>
  <div class="card ${(s.validationErrors || 0) > 0 ? 'error' : 'ok'}">
    <div class="label">Erros</div><div class="value">${s.validationErrors || 0}</div>
  </div>
  <div class="card ${inconsistencies.length > 0 ? 'warn' : 'ok'}">
    <div class="label">Inconsistências</div><div class="value">${inconsistencies.length}</div>
  </div>
  <div class="card"><div class="label">Firebase / DL</div><div class="value" style="font-size:16px">${s.ga4Count || 0} / ${s.dlCount || 0}</div></div>
</div>

${coverageSectionHtml}

${errorSummaryHtml}

${groupedDetailHtml}

${parceirosHtml}

${promotionPairsHtml}

${inconsistenciesHtml}

<h2>Eventos (${allEvents.length})</h2>
<table>
  <thead><tr><th>#</th><th>Evento</th><th>Fonte</th><th>Validação</th><th>Parâmetros</th></tr></thead>
  <tbody>${eventsRows}</tbody>
</table>
</body>
</html>`;
}

function gerarHTMLRelatorioMobileEvento(sessao, eventName, regiao, theme) {
  const ga4Events = sessao.payload?.ga4Events ?? sessao.ga4Events ?? [];
  const dlEvents  = sessao.payload?.dlEvents  ?? sessao.dlEvents  ?? [];
  const ts = sessao.timestamp ? new Date(sessao.timestamp).toLocaleString('pt-BR') : '—';

  // Filtro por região é opcional: um evento sem região própria na ocorrência (ex.: session_start)
  // nunca é excluído — mesma regra de tolerância usada em calcularScoreSessaoApp/extrairRegionEventoOverviewApp.
  const regiaoNorm = regiao ? normalizarRegiaoOverviewApp(regiao) : null;
  const matchRegiao = ev => {
    if (!regiaoNorm) return true;
    const r = ev.params?.region ?? ev.region ?? ev.ecommerce?.region ?? null;
    if (!r) return true;
    return normalizarRegiaoOverviewApp(r) === regiaoNorm;
  };

  const firebaseEvs = ga4Events.filter(e => (e.event_name || e.event) === eventName && matchRegiao(e));
  const dlEvs       = dlEvents.filter(e => (e.event_name || e.event) === eventName && matchRegiao(e));
  const allEvs      = [...firebaseEvs, ...dlEvs];

  // Paleta idêntica à área de saúde do App (mobile/dashboard.html, .app-health-page) — mesmos
  // tokens claro/escuro, pra abrir o relatório a partir de um evento manter o mesmo layout/tema.
  const dark = theme === 'dark';
  const t = dark ? {
    bg: '#0f172a', surface: '#1e293b', surfaceAlt: '#334155',
    border: 'rgba(148,163,184,.28)', borderSubtle: 'rgba(148,163,184,.14)',
    ink: '#f1f5f9', muted: '#94a3b8', faint: '#cbd5e1', decoration: '#475569',
    ok: '#4ade80', warn: '#fbbf24', error: '#f87171',
    okTint: 'rgba(74,222,128,.16)', warnTint: 'rgba(251,191,36,.16)', errorTint: 'rgba(248,113,113,.10)', neutralTint: 'rgba(148,163,184,.16)',
    shadow: '0 2px 8px rgba(0,0,0,.35), 0 1px 2px rgba(0,0,0,.25)',
  } : {
    bg: '#f1f5f9', surface: '#fff', surfaceAlt: '#f8fafc',
    border: '#e2e8f0', borderSubtle: '#f1f5f9',
    ink: '#0f172a', muted: '#64748b', faint: '#475569', decoration: '#94a3b8',
    ok: '#15803d', warn: '#854d0e', error: '#dc2626',
    okTint: '#dcfce7', warnTint: '#fef9c3', errorTint: '#fee2e2', neutralTint: '#f1f5f9',
    shadow: '0 2px 8px rgba(15,23,42,.07), 0 1px 2px rgba(15,23,42,.04)',
  };

  const totalFired   = allEvs.length;
  const withErrors   = allEvs.filter(e => { const v = e._meta?.validation; return v && !v.skipped && !v.valid; }).length;
  const passed       = totalFired - withErrors;
  const withWarnings = allEvs.filter(e => (e._meta?.validation?.warnings || []).length > 0).length;

  const hasErrors   = withErrors > 0;
  const statusText  = hasErrors ? 'Requer atenção' : 'Passou';
  const statusBg    = hasErrors ? t.errorTint : t.okTint;
  const statusColor = hasErrors ? t.error : t.ok;

  // Erros agregados
  const errCounts = {};
  allEvs.forEach(ev => {
    (ev._meta?.validation?.errors || []).forEach(err => { errCounts[err] = (errCounts[err] || 0) + 1; });
  });
  const errTableRows = Object.entries(errCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([err, n]) => `<tr><td><code>${esc(err)}</code></td><td class="num">${n}</td></tr>`)
    .join('');
  const errorSectionHtml = Object.keys(errCounts).length > 0
    ? `<table><thead><tr><th>Erro</th><th>Qtd</th></tr></thead><tbody>${errTableRows}</tbody></table>`
    : `<p class="empty-msg">Nenhum erro de schema encontrado ✓</p>`;

  // Avisos agregados
  const warnCounts = {};
  allEvs.forEach(ev => {
    (ev._meta?.validation?.warnings || []).forEach(w => { warnCounts[w] = (warnCounts[w] || 0) + 1; });
  });
  const warnTableRows = Object.entries(warnCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `<tr><td><code>${esc(w)}</code></td><td class="num">${n}</td></tr>`)
    .join('');
  const warnSectionHtml = Object.keys(warnCounts).length > 0
    ? `<table><thead><tr><th>Aviso</th><th>Qtd</th></tr></thead><tbody>${warnTableRows}</tbody></table>`
    : `<p class="empty-msg">Nenhum aviso encontrado ✓</p>`;

  // Linha de detalhamento agrupado
  const uniqueErrs   = [...new Set(allEvs.flatMap(e => e._meta?.validation?.errors || []))];
  const uniqueWarns  = [...new Set(allEvs.flatMap(e => e._meta?.validation?.warnings || []))];
  const okCount      = allEvs.reduce((acc, ev) => acc + Object.keys(ev.params || ev.ecommerce || {}).length, 0);
  const statusBadge  = withErrors === 0
    ? '<span class="badge badge-ok">✅ ok</span>'
    : `<span class="badge badge-error">❌ falhou</span>`;
  const errListHtml  = uniqueErrs.length > 0
    ? `<ul class="err-list">${uniqueErrs.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`
    : '—';
  const warnHtml = uniqueWarns.length > 0
    ? `<ul class="warn-list">${uniqueWarns.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`
    : '—';
  const groupedRow = totalFired === 0 ? '' : `<tr>
    <td><strong>${esc(eventName)}</strong></td>
    <td>${statusBadge}</td>
    <td>${errListHtml}</td>
    <td>${warnHtml}</td>
    <td class="num">${okCount > 0 ? okCount + ' ok' : '—'}</td>
  </tr>`;

  function renderPayloads(events, label) {
    if (!events.length) return '';
    const blocks = events.map((ev, i) => {
      const params = ev.params || ev.ecommerce || {};
      return `<div class="payload-block">
        <div class="payload-title">${i + 1}. ${esc(eventName)}</div>
        <pre class="params-full">${esc(JSON.stringify(expandJsonStringParamsApp(params), null, 2))}</pre>
      </div>`;
    }).join('');
    return `<h2>Parâmetros Coletados — ${esc(label)} (${events.length} evento${events.length !== 1 ? 's' : ''})</h2>${blocks}`;
  }

  const geradoEm = new Date().toLocaleString('pt-BR');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Faro App — ${esc(eventName)} — ${esc(sessao.sessionId)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 13px; color: ${t.ink}; background: ${t.bg}; margin: 0; padding: 28px 32px; }
  .header { margin-bottom: 20px; }
  h1 { font-size: 20px; color: ${t.ink}; margin: 0 0 4px; font-weight: 700; letter-spacing: -.02em; }
  .sub { font-size: 12px; color: ${t.muted}; }
  .filter-label { display: inline-block; background: ${t.surfaceAlt}; color: ${t.faint}; font-size: 11px; padding: 3px 10px; border-radius: 6px; margin-top: 8px; margin-right: 6px; font-weight: 600; }
  .meta-row { display: flex; gap: 24px; margin: 14px 0 20px; font-size: 12px; color: ${t.muted}; }
  .meta-row strong { color: ${t.ink}; }
  .status-badge { display: inline-block; padding: 6px 16px; border-radius: 8px; font-size: 13px; font-weight: 700; margin-bottom: 20px; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 28px; }
  .card { background: ${t.surface}; border: 1px solid ${t.border}; border-radius: 12px; padding: 16px 18px; text-align: center; box-shadow: ${t.shadow}; }
  .card .label { font-size: 10px; font-weight: 700; color: ${t.muted}; text-transform: uppercase; letter-spacing: .07em; margin-bottom: 6px; }
  .card .value { font-size: 28px; font-weight: 700; color: ${t.ink}; letter-spacing: -.02em; }
  .card.error .value { color: ${t.error}; }
  .card.warn  .value { color: ${t.warn}; }
  .card.ok    .value { color: ${t.ok}; }
  h2 { font-size: 11px; font-weight: 700; color: ${t.muted}; text-transform: uppercase; letter-spacing: .07em; border-bottom: 1px solid ${t.border}; padding-bottom: 8px; margin: 28px 0 14px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { font-size: 10px; font-weight: 700; color: ${t.muted}; text-transform: uppercase; letter-spacing: .05em; padding: 7px 10px; border-bottom: 2px solid ${t.border}; text-align: left; }
  td { padding: 8px 10px; border-bottom: 1px solid ${t.borderSubtle}; vertical-align: top; font-size: 12px; }
  .badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 20px; }
  .badge-ok    { background: ${t.okTint}; color: ${t.ok}; }
  .badge-error { background: ${t.errorTint}; color: ${t.error}; }
  .badge-na    { background: ${t.neutralTint}; color: ${t.muted}; }
  .badge-warn  { background: ${t.warnTint}; color: ${t.warn}; }
  .err-list  { margin: 4px 0 0; padding-left: 14px; color: ${t.error}; font-size: 11px; }
  .warn-list { margin: 4px 0 0; padding-left: 14px; color: ${t.warn}; font-size: 11px; }
  code { background: ${t.surfaceAlt}; color: ${t.ink}; padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 11px; }
  td.num { text-align: center; font-weight: 700; }
  .empty-msg { font-size: 12px; color: ${t.muted}; font-style: italic; margin: 0 0 20px; padding: 10px 12px; background: ${t.surfaceAlt}; border-radius: 6px; }
  .payload-block { margin-bottom: 20px; }
  .payload-title { font-size: 11px; font-weight: 700; background: #1e293b; color: #f8fafc; padding: 7px 12px; border-radius: 6px 6px 0 0; letter-spacing: .03em; }
  .params-full { background: ${t.surfaceAlt}; color: ${t.ink}; border: 1px solid ${t.border}; border-top: none; border-radius: 0 0 6px 6px; padding: 12px; font-size: 11px; white-space: pre-wrap; word-break: break-all; margin: 0; font-family: 'Cascadia Code', 'Fira Code', ui-monospace, monospace; }
  .footer { margin-top: 36px; text-align: center; font-size: 11px; color: ${t.decoration}; border-top: 1px solid ${t.border}; padding-top: 14px; }
</style>
</head>
<body>
<div class="header">
  <h1>Faro App — Relatório de Sessão Mobile</h1>
  <div class="sub">Firebase Analytics · grupo</div>
  <span class="filter-label">Evento: ${esc(eventName)}</span>${regiao ? `<span class="filter-label">Região: ${esc(regiao)}</span>` : ''}
</div>
<div class="meta-row">
  <span>📄 Sessão: <strong>${esc(sessao.sessionId)}</strong></span>
  <span>🏷️ Marca: <strong>${esc(sessao.marca || '—')}</strong></span>
  <span>📅 Data: <strong>${esc(ts)}</strong></span>
</div>

<div class="status-badge" style="background:${statusBg};color:${statusColor}">${statusText}</div>

<div class="cards">
  <div class="card"><div class="label">Disparos</div><div class="value">${totalFired}</div></div>
  <div class="card ${passed > 0 && withErrors === 0 ? 'ok' : ''}"><div class="label">Passaram</div><div class="value">${passed}</div></div>
  <div class="card ${withErrors > 0 ? 'error' : ''}"><div class="label">Com erro</div><div class="value">${withErrors}</div></div>
  <div class="card ${withWarnings > 0 ? 'warn' : ''}"><div class="label">Avisos</div><div class="value">${withWarnings}</div></div>
</div>

<h2>Erros de Schema (Campos Ausentes ou Tipo Errado)</h2>
${errorSectionHtml}

<h2>Avisos (${withWarnings} ocorrência${withWarnings !== 1 ? 's' : ''})</h2>
${warnSectionHtml}

<h2>Detalhamento — Eventos (Agrupado)</h2>
${totalFired === 0
  ? `<p class="empty-msg">Evento "${esc(eventName)}" não foi disparado nesta sessão.</p>`
  : `<table>
  <thead><tr><th>Evento</th><th>Status</th><th>Erros</th><th>Avisos</th><th>OK</th></tr></thead>
  <tbody>${groupedRow}</tbody>
</table>`}

${renderPayloads(firebaseEvs, 'Firebase')}
${renderPayloads(dlEvs, 'DataLayer')}

<div class="footer">Gerado automaticamente pelo Faro App · ${esc(geradoEm)}</div>
</body>
</html>`;
}

app.get('/api/mobile/sessions/:marca/:sessionId/html', async (req, res) => {
  const { marca, sessionId } = req.params;
  const eventFilter = req.query.event || null;
  const regiaoFilter = req.query.regiao || null;
  const theme = req.query.theme === 'dark' ? 'dark' : 'light';
  const filePath = resolveMobileSessionLocalPath(marca, sessionId);
  let sessao;
  if (filePath) {
    sessao = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } else {
    const found = await fetchMobileSessionFromGithub(marca, sessionId);
    if (!found) return res.status(404).json({ error: 'Sessão não encontrada' });
    sessao = found.content;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(eventFilter ? gerarHTMLRelatorioMobileEvento(sessao, eventFilter, regiaoFilter, theme) : gerarHTMLRelatorioMobile(sessao));
});

app.get('/api/mobile/sessions/:marca/:sessionId/report', async (req, res) => {
  const { marca, sessionId } = req.params;
  const eventFilter = req.query.event || null;
  const regiaoFilter = req.query.regiao || null;
  const theme = req.query.theme === 'dark' ? 'dark' : 'light';
  const filePath = resolveMobileSessionLocalPath(marca, sessionId);
  let sessao;
  if (filePath) {
    try {
      sessao = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return res.status(500).json({ error: 'Erro ao ler sessão' });
    }
  } else {
    const found = await fetchMobileSessionFromGithub(marca, sessionId);
    if (!found) return res.status(404).json({ error: 'Sessão não encontrada' });
    sessao = found.content;
  }
  let html = eventFilter ? gerarHTMLRelatorioMobileEvento(sessao, eventFilter, regiaoFilter, theme) : gerarHTMLRelatorioMobile(sessao);
  const webOverride = `<style>
    body { max-width: 960px; margin: 0 auto; padding: 32px 24px; box-sizing: border-box; }
    .cards { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
    table { display: block; overflow-x: auto; }
  </style>`;
  html = html.replace('</head>', webOverride + '</head>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/api/mobile/sessions/:marca/:sessionId/pdf', async (req, res) => {
  const { marca, sessionId } = req.params;
  const eventFilter = req.query.event || null;
  const regiaoFilter = req.query.regiao || null;
  const theme = req.query.theme === 'dark' ? 'dark' : 'light';
  const filePath = resolveMobileSessionLocalPath(marca, sessionId);
  let sessao;
  if (filePath) {
    try {
      sessao = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return res.status(500).json({ error: 'Erro ao ler sessão' });
    }
  } else {
    const found = await fetchMobileSessionFromGithub(marca, sessionId);
    if (!found) return res.status(404).json({ error: 'Sessão não encontrada' });
    sessao = found.content;
  }
  try {
    const { chromium } = require('@playwright/test');
    const browser  = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
    const page     = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const html     = eventFilter ? gerarHTMLRelatorioMobileEvento(sessao, eventFilter, regiaoFilter, theme) : gerarHTMLRelatorioMobile(sessao);
    const filename = eventFilter ? `relatorio-${sessionId}-${eventFilter}.pdf` : `relatorio-mobile-${sessionId}.pdf`;
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' } });
    await browser.close();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao gerar PDF: ' + e.message });
  }
});

app.get('/api/mobile/sessions/:marca/:sessionId/coverage', async (req, res) => {
  const { marca, sessionId } = req.params;
  const filePath = resolveMobileSessionLocalPath(marca, sessionId);
  let sessao;
  if (filePath) {
    try { sessao = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return res.status(500).json({ error: 'Erro ao ler sessão' }); }
  } else {
    const found = await fetchMobileSessionFromGithub(marca, sessionId);
    if (!found) return res.status(404).json({ error: 'Sessão não encontrada' });
    sessao = found.content;
  }

  const mobileSchema    = require('./mobile/mobile-schema.json');
  const schemaEventNames = Object.keys(mobileSchema.events);
  const allEvents       = [
    ...(sessao.payload?.ga4Events ?? sessao.ga4Events ?? []),
    ...(sessao.payload?.dlEvents  ?? sessao.dlEvents  ?? []),
  ];

  const coverage = schemaEventNames.map(eventName => {
    const occs = allEvents.filter(e => (e.event_name || e.event) === eventName);
    if (!occs.length) return { event: eventName, fired: false, count: 0, valid: null, errors: [] };
    const allErrors = [...new Set(occs.flatMap(e => e._meta?.validation?.errors || []))];
    const valid     = occs.every(e => { const v = e._meta?.validation; return !v || v.skipped || v.valid; });
    return { event: eventName, fired: true, count: occs.length, valid, errors: allErrors };
  });

  const fired = coverage.filter(e => e.fired).length;
  const total = coverage.length;
  res.json({ coverage, fired, total, pct: total > 0 ? Math.round((fired / total) * 100) : 0 });
});

app.get('/api/mobile/health/:marca', async (req, res) => {
  const { marca } = req.params;
  const { platform: platformFilter, session: sessionFilter } = req.query;

  const mobileSchema     = require('./mobile/mobile-schema.json');
  const schemaEventNames = new Set(Object.keys(mobileSchema.events));

  let sessions = await getMobileSessions(marca);

  const platforms = [...new Set(sessions.map(s => s.platform || 'android'))].sort();
  if (platformFilter) sessions = sessions.filter(s => (s.platform || 'android') === platformFilter);
  if (sessionFilter)  sessions = sessions.filter(s => s.sessionId === sessionFilter);

  if (!sessions.length) return res.json({ eventos: [], resumo: { total: 0, passou: 0, falhou: 0, pct: 0 }, sessoes: 0, schemaTotal: schemaEventNames.size, cobertura: 0, platforms, sessionFilter: sessionFilter || null });

  const mapa = {};
  for (const sessao of sessions) {
    // Formato antigo (histórico): eventos em sessao.payload.*
    // Formato atual (unificado): eventos direto em sessao.ga4Events/dlEvents
    const allEvents = [
      ...(sessao.payload?.ga4Events ?? sessao.ga4Events ?? []),
      ...(sessao.payload?.dlEvents  ?? sessao.dlEvents  ?? []),
    ];
    for (const ev of allEvents) {
      const nome = ev.event_name || ev.event;
      if (!nome || !schemaEventNames.has(nome)) continue;
      if (!mapa[nome]) mapa[nome] = { evento: nome, total: 0, passou: 0, falhou: 0, erros: {}, sessoes: new Set(), regioes: {} };
      const m = mapa[nome];
      m.total++;
      m.sessoes.add(sessao.sessionId);
      const r = ev.params?.region;
      if (r && typeof r === 'string') m.regioes[r] = (m.regioes[r] || 0) + 1;
      const v = ev._meta?.validation;
      if (!v || v.skipped || v.valid) m.passou++;
      else { m.falhou++; (v.errors || []).forEach(e => { m.erros[e] = (m.erros[e] || 0) + 1; }); }
    }
  }

  const disparados = Object.values(mapa).map(m => ({
    evento: m.evento, total: m.total, passou: m.passou, falhou: m.falhou,
    pct:    m.total > 0 ? Math.round((m.passou / m.total) * 100) : 0,
    erros:  Object.entries(m.erros).sort((a,b) => b[1]-a[1]).slice(0,5).map(([msg,count]) => ({msg,count})),
    sessoes: m.sessoes.size,
    priority:      mobileSchema.events[m.evento]?.priority || null,
    coverageNote:  mobileSchema.events[m.evento]?.coverageNote || null,
    regioes:       m.regioes,
  }));
  const ausentes = [...schemaEventNames].filter(n => !mapa[n]).map(n => ({ evento: n, total: 0, passou: 0, falhou: 0, pct: 0, erros: [], sessoes: 0, priority: mobileSchema.events[n]?.priority || null, coverageNote: mobileSchema.events[n]?.coverageNote || null, regioes: {} }));
  const eventos  = [...disparados.sort((a,b) => a.pct - b.pct), ...ausentes];

  // ── Discrepâncias ─────────────────────────────────────────────────────────
  const discrepMapFields = {};
  for (const sessao of sessions) {
    const incs = sessao.summary?.inconsistencies || [];
    const seen = new Set();
    for (const inc of incs) {
      if (!seen.has(inc.field)) {
        seen.add(inc.field);
        discrepMapFields[inc.field] = (discrepMapFields[inc.field] || 0) + 1;
      }
    }
  }
  const discrepancias = Object.entries(discrepMapFields)
    .map(([field, sessoes]) => ({ field, sessoes, pct: Math.round(sessoes / sessions.length * 100) }))
    .sort((a, b) => b.sessoes - a.sessoes);

  // ── Not set ────────────────────────────────────────────────────────────────
  const notSetMap = {};
  const NOT_SET_VALUES = new Set(['', 'not set', '(not set)', 'Not set', 'NOT SET']);
  for (const sessao of sessions) {
    const allEvs = [
      ...(sessao.payload?.ga4Events ?? sessao.ga4Events ?? []),
      ...(sessao.payload?.dlEvents  ?? sessao.dlEvents  ?? []),
    ];
    for (const ev of allEvs) {
      const params = { ...(ev.params || {}), ...(ev.ecommerce || {}) };
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v) || (v !== null && typeof v === 'object')) continue;
        if (v === null || NOT_SET_VALUES.has(String(v))) {
          if (!notSetMap[k]) notSetMap[k] = 0;
          notSetMap[k]++;
        }
      }
    }
  }
  const notSet = Object.entries(notSetMap)
    .map(([param, ocorrencias]) => ({ param, ocorrencias }))
    .sort((a, b) => b.ocorrencias - a.ocorrencias);

  // ── Parceiros ──────────────────────────────────────────────────────────────
  const parceirosMapa = {};
  for (const sessao of sessions) {
    const seen = new Set();
    for (const p of (sessao.payload?.parceiros ?? sessao.parceiros ?? [])) {
      if (!seen.has(p.nome)) {
        seen.add(p.nome);
        if (!parceirosMapa[p.nome]) parceirosMapa[p.nome] = { nome: p.nome, categoria: p.categoria, sessoes: 0 };
        parceirosMapa[p.nome].sessoes++;
      }
    }
  }
  const parceiros = Object.values(parceirosMapa)
    .map(p => ({ ...p, pct: Math.round(p.sessoes / sessions.length * 100) }))
    .sort((a, b) => b.sessoes - a.sessoes);

  const totalOcorrencias = disparados.reduce((s,e) => s + e.total, 0);
  const totalPassou      = disparados.reduce((s,e) => s + e.passou, 0);
  res.json({
    eventos,
    resumo: { total: totalOcorrencias, passou: totalPassou, falhou: disparados.reduce((s,e) => s + e.falhou, 0), pct: totalOcorrencias > 0 ? Math.round((totalPassou / totalOcorrencias) * 100) : 0 },
    sessoes:     sessions.length,
    schemaTotal: schemaEventNames.size,
    cobertura:   Math.round((Object.keys(mapa).length / schemaEventNames.size) * 100),
    platforms,
    platformFilter: platformFilter || null,
    sessionFilter:  sessionFilter  || null,
    discrepancias,
    notSet,
    parceiros,
  });
});

// ─── ROTAS LIVE FEED MOBILE (devem ficar antes do catch-all do dashboard) ─────

app.get('/api/mobile/sessions/active', (req, res) => {
  const activeId = captureState.sessionId;
  const all = getActiveSessions();
  res.json(activeId ? all.filter(s => s.sessionId === activeId) : []);
});

app.get('/api/mobile/live/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay buffer para o cliente que reconectou ou chegou depois do início
  const buffer = liveBuffer.get(sessionId) || [];
  if (buffer.length > 0) {
    try { res.write(`data: ${JSON.stringify({ type: 'replay_start' })}\n\n`); } catch (_) {}
    for (const payload of buffer) {
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
    }
  }

  if (!liveConnections.has(sessionId)) liveConnections.set(sessionId, new Set());
  liveConnections.get(sessionId).add(res);

  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (_) {} }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    liveConnections.get(sessionId)?.delete(res);
  });
});

// ─── MOBILE: Controle de captura ADB via dashboard ───────────────────────────

app.get('/api/mobile/adb/devices', (req, res) => {
  const adbPath = process.env.ADB_PATH || 'C:\\platform-tools\\adb.exe';
  const proc = spawn(adbPath, ['devices', '-l'], { shell: false });
  let out = '';
  proc.stdout.on('data', d => out += d.toString());
  proc.on('close', () => {
    const devices = [];
    for (const line of out.split('\n').slice(1)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('*')) continue;
      const [serial, state] = trimmed.split(/\s+/);
      if (state === 'device') {
        const isEmulator = serial.startsWith('emulator-');
        devices.push({ serial, isEmulator, label: isEmulator ? `Emulador AVD (${serial})` : serial });
      }
    }
    res.json({ devices });
  });
  proc.on('error', () => res.json({ devices: [], error: 'ADB não encontrado' }));
});

let captureProcess = null;
let captureState   = { status: 'idle', marca: null, device: null, sessionId: null, startedAt: null };
const captureStopFlags = new Map();

app.get('/api/mobile/capture/status', (req, res) => {
  res.json(captureState);
});

app.post('/api/mobile/capture/start', (req, res) => {
  if (captureProcess) return res.status(400).json({ error: 'Captura já em andamento' });
  const { marca, device, nome, pasta } = req.body;
  if (!marca || !device) return res.status(400).json({ error: 'marca e device são obrigatórios' });
  // device aceita ":" por causa de serial de ADB via Wi-Fi (ex.: 192.168.0.5:5555)
  if (!isSafeId(marca) || !/^[A-Za-z0-9_.:-]{1,64}$/.test(device)) return res.status(400).json({ error: 'marca ou device inválido' });

  const script = path.join(__dirname, 'mobile', 'adb-capture.js');
  const child  = spawn('node', [script, marca, device, nome || '', pasta || ''], { cwd: __dirname });

  captureProcess = child;
  captureState   = { status: 'recording', marca, device, sessionId: null, startedAt: new Date().toISOString() };

  child.stdout.on('data', data => {
    const text = data.toString();
    process.stdout.write(text);
    const m = text.match(/Sessão:\s+(adb-\S+)/);
    if (m) captureState.sessionId = m[1];
  });
  child.stderr.on('data', data => process.stderr.write(data.toString()));
  child.on('close', () => {
    const sid = captureState.sessionId;
    captureProcess = null;
    captureState   = { status: 'idle', marca: null, device: null, sessionId: null, startedAt: null };
    if (sid) finalizeSession(sid); // remove de activeSessions se process morreu sem chamar session/stop
  });

  res.json({ success: true, marca, device });
});

app.get('/api/mobile/capture/should-stop/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const stop = captureStopFlags.get(sessionId) === true;
  if (stop) captureStopFlags.delete(sessionId);
  res.json({ stop });
});

app.post('/api/mobile/capture/stop', (req, res) => {
  const sid = captureState.sessionId;
  if (sid) captureStopFlags.set(sid, true);
  if (captureProcess) {
    // Processo gerenciado pelo servidor: sinaliza parada via flag, adb-capture faz session/stop sozinho
    // Não matar o processo aqui — o SIGINT handler em adb-capture precisa rodar para salvar a sessão
  } else if (captureState.status === 'recording') {
    // Processo gerenciado pelo faro-agente: apenas reseta estado
    // NÃO chamar finalizeSession aqui — faro-agente chamará session/stop diretamente
    captureState = { status: 'idle', marca: null, device: null, sessionId: null, startedAt: null };
  }
  res.json({ success: true, sessionId: sid });
});

// Rotas de expansão mobile
app.post('/api/mobile/session/start', (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'Body ausente. Envie Content-Type: application/json.' });
  const { sessionId, marca, device, platform, nome, pasta, appVersion } = req.body;
  if (!sessionId || !marca) return res.status(400).json({ error: 'sessionId e marca são obrigatórios.' });
  // sessionId e marca viram nome de arquivo e aparecem no dashboard — formato restrito
  // (pentest 11/2026, achado 5.2: o payload XSS entrou por aqui).
  if (!isSafeId(sessionId) || !isSafeId(marca)) return res.status(400).json({ error: 'sessionId ou marca com formato inválido.' });
  startSession(sessionId, marca, platform, nome || null, pasta || null, appVersion || null);
  if (captureState.status === 'idle') {
    captureState = { status: 'recording', marca, device: device || 'externo', sessionId, startedAt: new Date().toISOString() };
  }
  res.status(200).send({ status: 'started' });
});

app.post('/api/mobile/ingest/:sessionId', (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'Body ausente. Envie Content-Type: application/json.' });
  pushEvent(req.params.sessionId, req.body);
  if (req.body.event_name === 'screen_view' && req.body.params && req.body.params.region) {
    updateScreenContext(req.params.sessionId, req.body.params.region);
  }
  const session = getSession(req.params.sessionId);
  const context = session ? { marca: session.marca, region: session.currentRegion } : undefined;
  let liveEvent = req.body;
  if (isFirebaseHit(req.body)) liveEvent = normalizeFirebaseHit(req.body, context);
  else if (isDataLayerPush(req.body)) liveEvent = normalizeDataLayerPush(req.body, context);
  broadcastLive(req.params.sessionId, { type: 'event', event: liveEvent });
  res.json({ ok: true });
});

app.post('/api/mobile/session/stop/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!captureProcess && captureState.sessionId === sessionId) {
    captureState = { status: 'idle', marca: null, device: null, sessionId: null, startedAt: null };
  }
  const rawSession = finalizeSession(sessionId);
  if (!rawSession) return res.status(404).send({ error: 'Session not found' });

  let normalized, _summary, payload;
  try {
    normalized = normalizeMobileSession(rawSession);
    ({ _summary, ...payload } = normalized);
  } catch (normErr) {
    console.error('normalizeMobileSession erro:', normErr.message);
    // Salva sessão bruta para não perder os dados
    const marca = rawSession.marca;
    const sessionData = {
      sessionId,
      marca,
      nome: rawSession.nome || null,
      pasta: rawSession.pasta || null,
      appVersion: rawSession.appVersion || null,
      platform: rawSession.platform || 'android',
      timestamp: new Date().toISOString(),
      summary: { normalizationError: normErr.message },
      payload: { marca, rawEvents: rawSession.rawEvents },
    };
    const fileContent = JSON.stringify(sessionData, null, 2);
    const filePath = `sessions/mobile/${marca}/${sessionId}.json`;
    const localDir = path.join(__dirname, 'sessions', 'mobile', marca);
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, `${sessionId}.json`), fileContent);
    return res.status(200).json({
      status: 'normalization_error',
      error: normErr.message,
      persisted: filePath,
    });
  }

  const marca = payload.marca;

  // Converte ga4Events (formato rico do Faro App) para o dl-like que o
  // validator.js espera — mesmo contrato que o Faro Web usa pra validar
  // sessões de app, pra área de saúde oficial (dele) conseguir ler sem
  // nenhuma mudança do lado dela. Ver mobile/payload-mapper.js.
  const dlEventsMobile = buildDlLikeFromGa4Events(payload.ga4Events);
  let validacao, inconsistenciasValidator, comparacaoMobile;
  try {
    const { validateAll, verificarConsistencia, compararViewSelectPromotion } = require('./validator');
    validacao                = validateAll(dlEventsMobile);
    inconsistenciasValidator = verificarConsistencia(dlEventsMobile);
    // Mesmo pareamento view_promotion <-> select_promotion que o web já tem —
    // aqui não faz sentido a parte de "disparou no DL mas não chegou no GA4"
    // (não existe essa distinção no app), só a comparação entre os dois eventos.
    // compararViewSelectPromotion pode não existir nessa versão do validator.js —
    // nesse caso só perde essa comparação específica, sem afetar validacao/inconsistencias.
    comparacaoMobile          = typeof compararViewSelectPromotion === 'function' ? compararViewSelectPromotion(dlEventsMobile) : [];
  } catch (e) {
    console.error('Erro na validação mobile via validator.js:', e.message);
    validacao                = { summary: { total: 0, passed: 0, failed: 0, unknown: 0, erros: 0 }, eventos: [] };
    inconsistenciasValidator = [];
    comparacaoMobile         = [];
  }

  const sessionData = {
    sessionId,
    nome:            rawSession.nome || null,
    pasta:           rawSession.pasta || null,
    appVersion:      rawSession.appVersion || null,
    testador:        '',
    marca,
    ambiente:        'app',
    platform:        rawSession.platform || 'android',
    timestamp:       new Date().toISOString(),
    startUrl:        '',
    dlEvents:        [],
    ga4Events:       payload.ga4Events,
    parceiros:       payload.parceiros,
    validacao,
    inconsistencias: inconsistenciasValidator,
    comparacao:      comparacaoMobile,
    // Resumo rico próprio do Faro App (Nível A/B/C, parceiros, etc.) — a área
    // de saúde oficial do Faro Web não lê isso, mas fica disponível pro
    // Faro App e pra investigação de bugs de captura.
    _summaryFaroApp: _summary,
  };
  const fileContent = JSON.stringify(sessionData, null, 2);
  const filePath = `sessions/${marca}/${sessionId}.json`;

  // Salva localmente — mesmo caminho das sessões web
  const localDir = path.join(__dirname, 'sessions', marca);
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, `${sessionId}.json`), fileContent);

  // Persiste no GitHub
  try {
    const result = await commitToGitHub(filePath, fileContent, `sessao mobile: ${sessionData.nome ?? sessionId} (${marca})`);
    console.log('Mobile session commit:', result?.commit?.sha?.slice(0, 8));
  } catch (e) {
    console.error('Mobile session commit erro:', e.message);
  }

  broadcastLive(sessionId, { type: 'session_ended', marca, sessionId });

  res.status(200).json({
    status: _summary.validationErrors > 0 ? 'has_errors' : 'ok',
    summary: _summary,
    payload,
    persisted: filePath,
  });
});

// ─── MOBILE: Rodar todos (replay da última sessão ADB capturada) ─────────────
app.post('/api/mobile/run-all/:marca', (req, res) => {
  const { marca } = req.params;
  const replayScript = path.join(__dirname, 'mobile', 'replay-last.js');
  // execFile sem shell + `marca` já validada por app.param. Não devolve stdout bruto ao
  // cliente: era por esse campo que o resultado dos comandos injetados voltava no pentest.
  execFile(process.execPath, [replayScript, marca], { cwd: __dirname, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
    if (err) {
      console.error('mobile/run-all erro:', stderr || err.message);
      return res.status(500).json({ success: false, error: 'falha ao executar o replay' });
    }
    res.json({ success: true });
  });
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

const dashboardDist = path.join(__dirname, 'dashboard', 'dist');
if (fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(dashboardDist, 'index.html'));
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));