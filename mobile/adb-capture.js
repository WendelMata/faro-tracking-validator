#!/usr/bin/env node
'use strict';

/**
 * Faro App — Captura ADB
 * Lê eventos Firebase do logcat Android e envia ao servidor Faro App.
 *
 * Uso:
 *   node mobile/adb-capture.js <marca>                   → USB (padrão, único dispositivo)
 *   node mobile/adb-capture.js <marca> <serial>          → serial do "adb devices" (USB, mDNS, emulador)
 *   node mobile/adb-capture.js <marca> <ip>              → Wi-Fi (porta 5555)
 *   node mobile/adb-capture.js <marca> <ip>:<porta>      → Wi-Fi (porta personalizada)
 *
 * Exemplos:
 *   node mobile/adb-capture.js nv
 *   node mobile/adb-capture.js nv 192.168.1.42
 *   node mobile/adb-capture.js marca-f 192.168.1.42:5555
 *
 * Wi-Fi — Android 11+:
 *   Configurações > Opções do desenvolvedor > Depuração wireless
 *   Anote o IP e porta exibidos, depois rode:
 *     adb pair <ip>:<porta-emparelhamento>   ← só na primeira vez por rede
 *     node mobile/adb-capture.js <marca> <ip>:<porta-depuracao>
 *
 * Wi-Fi — Android < 11 (requer USB uma vez):
 *   adb tcpip 5555
 *   (desconecte o USB)
 *   node mobile/adb-capture.js <marca> <ip-do-celular>
 *
 * Pré-requisitos:
 *   1. ADB instalado (Android SDK Platform Tools)
 *   2. Firebase debug mode ativo no app:
 *      adb shell setprop debug.firebase.analytics.app <pacote.do.app>
 *   3. Servidor Faro App rodando em localhost:3002
 */

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { parceiros: PARTNER_DEFS, brands: BRAND_PACKAGES, sdkComponents: SDK_COMPONENTS } = require('./mobile-partners.json');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';

const marca = process.argv[2];
const wifiArg = process.argv[3] || null;
const nomeArg = process.argv[4] || null;
const pastaArg = process.argv[5] || null;

if (!marca) {
  console.error('\n  Uso: node mobile/adb-capture.js <marca> [ip[:porta]]');
  console.error('  USB:   node mobile/adb-capture.js nv');
  console.error('  Wi-Fi: node mobile/adb-capture.js nv 192.168.1.42');
  console.error('  Wi-Fi: node mobile/adb-capture.js nv 192.168.1.42:37305\n');
  process.exit(1);
}

// Classifica o alvo. O script nasceu recebendo só IP de Wi-Fi, mas o agente local passa
// qualquer serial que o "adb devices" lista: serial USB ("0071688594"), mDNS da Depuração
// por Wi-Fi ("adb-…_adb-tls-connect._tcp"), emulador ("emulator-5554") ou IP:porta (depois
// do "Ativar TCP/IP"). Só endereço de rede precisa de "adb connect" — os demais já estão
// visíveis pro adb e só precisam do "-s <serial>". Achado real: serial USB virava
// "0071688594:5555", o "adb connect" falhava e a captura morria na hora, o que fazia
// parecer que só funcionava com TCP/IP ativado.
const isEmulator     = !!wifiArg && wifiArg.startsWith('emulator-');
const ehIPv4Puro     = !!wifiArg && /^\d{1,3}(\.\d{1,3}){3}$/.test(wifiArg);
const ehEnderecoRede = !!wifiArg && !isEmulator && (ehIPv4Puro || /^[^\s:]+:\d+$/.test(wifiArg));
const deviceTarget   = wifiArg ? (ehIPv4Puro ? `${wifiArg}:5555` : wifiArg) : null;

const sessionId = `adb-${marca}-${Date.now()}`;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function httpPost(apiPath, body) {
  const res = await fetch(`${SERVER_URL}${apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Faro-Token': process.env.FARO_API_TOKEN || '' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Wi-Fi ADB ─────────────────────────────────────────────────────────────────

function connectWifi(adbPath, target) {
  return new Promise((resolve, reject) => {
    const proc = spawn(adbPath, ['connect', target], { shell: false });
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => out += d.toString());
    proc.on('close', code => {
      const success = out.includes('connected') && !out.includes('failed') && !out.includes('unable');
      if (success) resolve(out.trim());
      else reject(new Error(out.trim() || `adb connect saiu com código ${code}`));
    });
    proc.on('error', reject);
  });
}

// ── Parser de Bundle do Firebase ─────────────────────────────────────────────

// Regra temporária de depuração: para investigar se o app da marca-a está de fato
// preenchendo screen_view, deixa esse evento passar sem o filtro de prefixo abaixo,
// pra ver exatamente o que o SDK está enviando (inclusive firebase_*/ga_*). Remover
// quando a investigação terminar.
const DEBUG_SKIP_PREFIX_FILTER = new Set(['screen_view']);

function parseSimpleParams(str, skipPrefixFilter) {
  const result = {};
  const pairs = str.split(/, (?=[a-zA-Z_][a-zA-Z0-9_(!)]*=)/);
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.substring(0, eq).trim();
    const rawVal = pair.substring(eq + 1).trim();
    const stripped = /^"(.*)"$/.test(rawVal) ? rawVal.slice(1, -1) : rawVal;
    const val = (!stripped.startsWith('[') && !stripped.startsWith('{')) ? stripped.replace(/","/g, ',') : stripped;
    if (!key || (!skipPrefixFilter && (key.startsWith('_') || key.startsWith('firebase_') || key.startsWith('ga_')))) continue;
    if (val === 'true') result[key] = true;
    else if (val === 'false') result[key] = false;
    else if (val !== '' && !isNaN(val)) result[key] = Number(val);
    else result[key] = val;
  }
  return result;
}

// Encontra o índice do "]" que fecha o "[" aberto em openIndex, contando apenas
// colchetes (ignora chaves). Isso permite que um valor de campo contenha um
// colchete balanceado (ex: nome de vitrine cadastrado como "AW25 [Untitled]")
// sem ser confundido com o fechamento estrutural do array — visto em produção
// (Marca C): a regex antiga (`[^\]]*`) parava no primeiro "]" que encontrasse,
// mesmo dentro de um valor, e o array "items" inteiro deixava de ser reconhecido.
function findMatchingBracket(str, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < str.length; i++) {
    if (str[i] === '[') depth++;
    else if (str[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Separa "Bundle[{...}], Bundle[{...}]" em cada item individual, usando o mesmo
// contador de profundidade — necessário pelo mesmo motivo de findMatchingBracket.
function splitBundleItems(inner) {
  const items = [];
  let i = 0;
  while (i < inner.length) {
    const bStart = inner.indexOf('Bundle[', i);
    if (bStart === -1) break;
    const openIdx = bStart + 'Bundle['.length - 1;
    const closeIdx = findMatchingBracket(inner, openIdx);
    if (closeIdx === -1) break;
    let segment = inner.slice(openIdx + 1, closeIdx);
    if (segment.startsWith('{') && segment.endsWith('}')) segment = segment.slice(1, -1);
    items.push(segment);
    i = closeIdx + 1;
  }
  return items;
}

function parseBundle(content, skipPrefixFilter) {
  const result = {};

  // Extrai items=[Bundle[{...}], Bundle[{...}]] contando profundidade de
  // colchetes em vez de regex (ver findMatchingBracket acima).
  const marker = 'items=[';
  const markerIdx = content.indexOf(marker);
  if (markerIdx !== -1) {
    const openIdx  = markerIdx + marker.length - 1;
    const closeIdx = findMatchingBracket(content, openIdx);
    if (closeIdx !== -1) {
      const inner = content.slice(openIdx + 1, closeIdx);
      result.items = splitBundleItems(inner).map(item => parseSimpleParams(item, skipPrefixFilter));
      const full = content.slice(markerIdx, closeIdx + 1);
      // Remover items=[...] do meio da string deixa uma vírgula duplicada exatamente
      // onde ele estava (ex: "brand=nv, , region=home") — colapsa antes de limpar as pontas,
      // senão a vírgula sobrando vaza para o valor do campo adjacente ("nv,").
      content = content.replace(full, '').replace(/,\s*,/g, ',').replace(/(^,\s*|,\s*$)/g, '');
    }
  }

  Object.assign(result, parseSimpleParams(content, skipPrefixFilter));
  return result;
}

// Firebase loga eventos automáticos com underscore (ex: _session_start) — normaliza para o nome público
const FIREBASE_EVENT_ALIASES = { '_session_start': 'session_start' };

// session_start aparece como "Session started, time: <ms>" no logcat FA — usado tanto
// pelo parser quanto pelo filtro de PID (que precisa reconhecer essa linha específica
// pra tratar sua race condition de cold start, ver comentário no filtro mais abaixo).
const SESSION_START_LINE_RE = /V\/FA\s+\(.*\):\s+Session started,\s+time:/i;

function normalizeEventName(name) {
  const aliased = FIREBASE_EVENT_ALIASES[name] || name;
  // Formato FA-SVC loga eventos automáticos com sufixo interno, ex: screen_view(_vs), session_start(_s) —
  // remove genericamente em vez de mapear cada evento automático um a um.
  return aliased.replace(/\(_\w+\)$/, '');
}

function parseFirebaseLine(line) {
  // Formato FA VERBOSE (log.tag.FA VERBOSE): parâmetros completos
  // D/FA (PID): Passing event to registered event handler (FE): event_name, Bundle[{...}]
  const faVerboseMatch = line.match(/FA\s+\(\s*\d+\):\s+Passing event to registered event handler \(FE\):\s+(\w+),\s+Bundle\[\{(.*)\}\]/);
  if (faVerboseMatch) {
    const eventName = normalizeEventName(faVerboseMatch[1]);
    return {
      isAnalyticsHit: true,
      event_name: eventName,
      params: parseBundle(faVerboseMatch[2], DEBUG_SKIP_PREFIX_FILTER.has(eventName)),
      _source: 'fa_verbose',
    };
  }

  // Formato Firebase nativo: FA: Logging event (FE): event_name, Bundle[{...}]
  const nativeMatch = line.match(/Logging event \(FE\):\s+(\w+),\s+Bundle\[\{(.*)\}\]/);
  if (nativeMatch) {
    const eventName = normalizeEventName(nativeMatch[1]);
    return {
      isAnalyticsHit: true,
      event_name: eventName,
      params: parseBundle(nativeMatch[2], DEBUG_SKIP_PREFIX_FILTER.has(eventName)),
      _source: 'fa_native',
    };
  }

  // Formato Flutter debug: fallback sem params
  const flutterMatch = line.match(/\[FIREBASE_ANALYTICS\] logEvent:\s+([a-zA-Z_]+)/);
  if (flutterMatch) {
    return {
      isAnalyticsHit: true,
      event_name: flutterMatch[1],
      params: {},
      _source: 'flutter_debug',
    };
  }

  // Formato FA-SVC: aparece quando o app não está em debug-verbose. origin varia
  // (app, auto, app+gtm...) — screen_view real da NV chegou com origin=auto no primeiro
  // disparo da sessão, então não pode ficar restrito a origin=app.
  // ex: FA-SVC (PID): Logging event: origin=app,name=view_promotion,params=Bundle[{...}]
  const faSvcMatch = line.match(/FA-SVC.*Logging event:\s+origin=[^,]+,name=([^,]+),params=Bundle\[\{(.*)\}\]/);
  if (faSvcMatch) {
    const eventName = normalizeEventName(faSvcMatch[1]);
    return {
      isAnalyticsHit: true,
      event_name: eventName,
      params: parseBundle(faSvcMatch[2], DEBUG_SKIP_PREFIX_FILTER.has(eventName)),
      _source: 'fa_svc',
    };
  }

  if (SESSION_START_LINE_RE.test(line)) {
    return {
      isAnalyticsHit: true,
      event_name: 'session_start',
      params: {},
      _source: 'fa_native',
    };
  }

  return null;
}

// ── Parser multi-linha do FA-SVC (regra temporária, só screen_view) ─────────
// Alguns dispositivos não logam o FA-SVC na linha única que parseFirebaseLine já
// reconhece ("Logging event: origin=...,params=Bundle[{...}]"). Em vez disso, despejam
// um lote multi-linha (dump do upload pro Firebase), tipo:
//   event {
//     name: screen_view(_vs)
//     param {
//       name: region
//       string_value: pdc
//     }
//     ...
//   }
// Este parser reconstrói só o bloco do screen_view a partir dessas linhas — não tenta
// cobrir o formato genérico pra outros eventos. Remover junto com as outras regras
// temporárias (DEBUG_SKIP_PREFIX_FILTER, attachDebugRaw, DEBUG_KEEP_FLUTTER_PARAMS)
// quando a investigação terminar.
let screenViewBlock = null; // { pid, depth, isTarget, params, curParamName, curParamValue }

function commitCurrentScreenViewParam() {
  if (screenViewBlock.curParamName !== null) {
    screenViewBlock.params[screenViewBlock.curParamName] = screenViewBlock.curParamValue;
  }
  screenViewBlock.curParamName = null;
  screenViewBlock.curParamValue = undefined;
}

function tryParseScreenViewMultiline(line) {
  const m = line.match(/FA-SVC\s+\(\s*(\d+)\):\s?(.*)$/);
  if (!m) return null;
  const pid = m[1];
  const content = m[2].trim();

  if (!screenViewBlock) {
    if (content === 'event {') {
      screenViewBlock = { pid, depth: 1, isTarget: null, params: {}, curParamName: null, curParamValue: undefined };
    }
    return null;
  }

  if (screenViewBlock.pid !== pid) {
    // Linha de outro processo intercalada no meio do bloco — descarta e reavalia esta linha do zero.
    screenViewBlock = null;
    return tryParseScreenViewMultiline(line);
  }

  if (screenViewBlock.isTarget === null) {
    const nameMatch = content.match(/^name:\s*(\S+)/);
    if (nameMatch) {
      screenViewBlock.isTarget = normalizeEventName(nameMatch[1]) === 'screen_view';
      if (!screenViewBlock.isTarget) screenViewBlock = null; // não é o evento que a gente quer
      return null;
    }
    if (content === '}') screenViewBlock = null; // fechou sem achar "name:" — não deveria acontecer
    return null;
  }

  if (content === 'param {') {
    screenViewBlock.depth++;
    return null;
  }

  if (content === '}') {
    screenViewBlock.depth--;
    if (screenViewBlock.depth === 1) {
      commitCurrentScreenViewParam();
      return null;
    }
    if (screenViewBlock.depth === 0) {
      const result = {
        isAnalyticsHit: true,
        event_name: 'screen_view',
        params: screenViewBlock.params,
        _source: 'fa_svc_multiline',
      };
      screenViewBlock = null;
      return result;
    }
    return null;
  }

  if (screenViewBlock.depth === 2) {
    const nameMatch = content.match(/^name:\s*(.*)$/);
    if (nameMatch) { screenViewBlock.curParamName = nameMatch[1].trim(); return null; }
    const strMatch = content.match(/^string_value:\s*(.*)$/);
    if (strMatch) { screenViewBlock.curParamValue = strMatch[1]; return null; }
    const intMatch = content.match(/^int_value:\s*(-?\d+)/);
    if (intMatch) { screenViewBlock.curParamValue = Number(intMatch[1]); return null; }
  }

  // Demais campos de nível de evento (timestamp_millis, corrected_timestamp_millis etc.) — ignora.
  return null;
}

// ── Parser de Parceiros ───────────────────────────────────────────────────────

function parsePartnerLine(line) {
  const lower = line.toLowerCase();
  for (const partner of PARTNER_DEFS) {
    const tagHit = partner.logcat_tags.some(tag => {
      return new RegExp('[DIWE]/' + tag.replace('.', '\\.') + '[\\s(]', 'i').test(line);
    });
    const kwHit = partner.logcat_keywords.some(kw => lower.includes(kw.toLowerCase()));
    if (tagHit || kwHit) {
      return { type: 'partner', nome: partner.nome, categoria: partner.categoria, raw: line.trim() };
    }
  }
  return null;
}

// ── Varredura estática de SDKs instalados ─────────────────────────────────────
// Lê o manifesto do app via `pm dump` e detecta componentes de SDKs conhecidos.
// Funciona mesmo que o SDK não logue nada durante a sessão.

// Lista os PIDs atuais do pacote (pode ter mais de um processo — app principal
// + serviços). log.tag.FA/FA-SVC VERBOSE é ligado pro aparelho inteiro, não só
// pro app da marca — sem filtrar por PID, qualquer outro app instalado que use
// Firebase Analytics (launcher/sistema, especialmente comum em MIUI/Xiaomi)
// vaza eventos pra dentro da sessão. Reconsultado periodicamente porque o app
// pode não estar aberto ainda no início da captura, ou reiniciar no meio dela
// (PID muda) — já observado antes neste projeto.
function getAppPids(adbPath, adbBaseArgs, packageName) {
  return new Promise(resolve => {
    if (!packageName) return resolve([]);
    const proc = spawn(adbPath, [...adbBaseArgs, 'shell', 'ps', '-A'], { shell: false });
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      const pids = [];
      for (const line of out.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 9) continue;
        const pid  = cols[1];
        const name = cols[cols.length - 1];
        if (name === packageName || name.startsWith(packageName + ':')) pids.push(pid);
      }
      resolve(pids);
    });
    proc.on('error', () => resolve([]));
  });
}

// Extrai o PID de uma linha de logcat no formato brief: "TAG     (PID): mensagem"
function extractLinePid(line) {
  const m = line.match(/\(\s*(\d+)\):/);
  return m ? m[1] : null;
}

// Versão instalada do app (versionName do manifesto) — dado estático, não
// depende do app estar aberto, por isso pode ser lido antes do session/start.
function getAppVersion(adbPath, adbBaseArgs, packageName) {
  return new Promise(resolve => {
    if (!packageName) return resolve(null);
    const proc = spawn(adbPath, [...adbBaseArgs, 'shell', 'dumpsys', 'package', packageName], { shell: false });
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      const m = out.match(/versionName=(\S+)/);
      resolve(m ? m[1] : null);
    });
    proc.on('error', () => resolve(null));
  });
}

function scanInstalledSdks(adbPath, adbBaseArgs, packageName) {
  return new Promise(resolve => {
    if (!packageName) return resolve([]);
    const proc = spawn(adbPath, [...adbBaseArgs, 'shell', 'pm', 'dump', packageName], { shell: false });
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      const detected = [];
      for (const [nome, patterns] of Object.entries(SDK_COMPONENTS || {})) {
        if (patterns.some(p => out.includes(p))) {
          const def = PARTNER_DEFS.find(d => d.nome === nome);
          detected.push({ type: 'partner', nome, categoria: def?.categoria || 'SDK', scanType: 'static' });
        }
      }
      resolve(detected);
    });
    proc.on('error', () => resolve([]));
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const adbPath = process.env.ADB_PATH || 'C:\\platform-tools\\adb.exe';
  const modoConexao = isEmulator     ? `Emulador (${deviceTarget})`
                    : ehEnderecoRede ? `Wi-Fi  (${deviceTarget})`
                    : deviceTarget   ? (deviceTarget.startsWith('adb-') ? `Wi-Fi mDNS (${deviceTarget})` : `USB (${deviceTarget})`)
                    : 'USB';

  console.log('\n══════════════════════════════════════');
  console.log('  Faro App — Captura ADB');
  console.log('══════════════════════════════════════');
  console.log(`  Marca:     ${marca}`);
  console.log(`  Sessão:    ${sessionId}`);
  console.log(`  Conexão:   ${modoConexao}`);
  console.log(`  Servidor:  ${SERVER_URL}`);
  console.log('══════════════════════════════════════\n');

  // "adb connect" só faz sentido pra endereço de rede — serial USB/mDNS/emulador já
  // está conectado e o connect nesses falha (ver classificação do alvo no topo).
  if (deviceTarget && ehEnderecoRede) {
    console.log(`  Conectando ao dispositivo ${deviceTarget}...`);
    try {
      const msg = await connectWifi(adbPath, deviceTarget);
      console.log(`  ✔ ${msg}\n`);
    } catch (e) {
      console.error(`  ✖ Falha ao conectar via Wi-Fi: ${e.message}`);
      console.error(`\n  Verifique:`);
      console.error(`    • Celular e computador na mesma rede Wi-Fi`);
      console.error(`    • Android 11+: Configurações > Opções do desenvolvedor > Depuração wireless`);
      console.error(`      Use o IP e porta mostrados nessa tela`);
      console.error(`    • Android < 11: conecte USB uma vez e rode:`);
      console.error(`      adb tcpip 5555\n`);
      process.exit(1);
    }
  }

  // Versão instalada do app — lida antes do session/start pra já ir junto no payload
  // (dado estático do manifesto, não depende do app estar aberto).
  const adbBaseArgs  = deviceTarget ? ['-s', deviceTarget] : [];
  const brandPackage = BRAND_PACKAGES?.[marca.toLowerCase()] || null;
  const appVersion = await getAppVersion(adbPath, adbBaseArgs, brandPackage);
  if (appVersion) console.log(`  ✔ Versão detectada: ${appVersion}`);
  else if (brandPackage) console.log(`  ⚠ Não foi possível detectar a versão do app instalado`);

  // Inicia sessão no servidor
  try {
    await httpPost('/api/mobile/session/start', { sessionId, marca, device: deviceTarget || 'USB', platform: 'android', nome: nomeArg, pasta: pastaArg, appVersion });
    console.log(`  ✔ Sessão iniciada`);
  } catch (e) {
    console.error(`  ✖ Servidor não encontrado em ${SERVER_URL}`);
    console.error(`    Inicie o servidor antes de rodar este script.\n`);
    process.exit(1);
  }

  let eventCount = 0;
  const partnersSeen = new Set();

  const faVerboseSeen = new Map(); // event_name -> timestamp
  const flutterQueue = new Map(); // event_name -> { event, timer }

  async function sendEvent(event) {
    try {
      await httpPost(`/api/mobile/ingest/${sessionId}`, event);
      eventCount++;
      const params = JSON.stringify(event.params);
      const preview = params.length > 120 ? params.slice(0, 120) + '…' : params;
      console.log(`  [${eventCount}] ${event.event_name}  →  ${preview}`);
    } catch (e) {
      console.error(`  ✖ Erro ao enviar evento: ${e.message}`);
    }
  }

  // Inicia o logcat ANTES do SDK scan para não perder o session_start:
  // O scan de SDK pode levar 5-10s em dispositivos Xiaomi/MIUI — se o app
  // for aberto durante esse período, o session_start é eviccionado do ring buffer
  // pelo ruído de sistema antes do logcat subir. Iniciando aqui, o processo já
  // está escutando quando o usuário reabre o app.
  const captureStart = new Date();
  const tsMonth = String(captureStart.getMonth() + 1).padStart(2, '0');
  const tsDay   = String(captureStart.getDate()).padStart(2, '0');
  const tsHour  = String(captureStart.getHours()).padStart(2, '0');
  const tsMin   = String(captureStart.getMinutes()).padStart(2, '0');
  const tsSec   = String(captureStart.getSeconds()).padStart(2, '0');
  const tsMs    = String(captureStart.getMilliseconds()).padStart(3, '0');
  const captureTimestamp = `${tsMonth}-${tsDay} ${tsHour}:${tsMin}:${tsSec}.${tsMs}`;

  // Ativa logs verbose do Firebase Analytics e debug mode para a marca
  // (adbBaseArgs/brandPackage já resolvidos mais acima, antes do session/start)

  function adbSetprop(key, value) {
    return new Promise(resolve => {
      const p = spawn(adbPath, [...adbBaseArgs, 'shell', 'setprop', key, value], { shell: false });
      p.on('close', resolve);
    });
  }

  await adbSetprop('log.tag.FA', 'VERBOSE');
  await adbSetprop('log.tag.FA-SVC', 'VERBOSE');
  if (brandPackage) {
    await adbSetprop('debug.firebase.analytics.app', brandPackage);
    console.log(`  ✔ Firebase debug mode → ${brandPackage}`);
  } else {
    console.log(`  ⚠ Package não mapeado para "${marca}" — setprop debug.firebase ignorado`);
  }

  // PIDs atuais do app da marca — atualizado a cada 1s pra filtrar ruído de
  // outros apps e acompanhar o app abrindo (ou reiniciando) durante a sessão.
  let currentAppPids = new Set();
  async function refreshAppPids() {
    if (!brandPackage) return;
    const pids = await getAppPids(adbPath, adbBaseArgs, brandPackage);
    currentAppPids = new Set(pids);
  }
  await refreshAppPids();
  const pidRefreshInterval = setInterval(refreshAppPids, 1000);

  const logcatArgs = deviceTarget
    ? ['-s', deviceTarget, 'logcat', '-T', captureTimestamp, '-v', 'brief']
    : ['logcat', '-T', captureTimestamp, '-v', 'brief'];
  const logcat = spawn(adbPath, logcatArgs, { shell: false });

  logcat.on('error', () => {
    console.error('\n  ✖ ADB não encontrado.');
    console.error('    Instale o Android SDK Platform Tools:');
    console.error('    https://developer.android.com/studio/releases/platform-tools\n');
    process.exit(1);
  });

  logcat.stderr.on('data', data => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('beginning of')) console.error(`  ADB: ${msg}`);
  });

  logcat.stdout.on('data', async data => {
    for (const line of data.toString().split('\n')) {
      if (/firebase|FA |FA-SVC|Logging event|Passing event|analytics/i.test(line)) {
        console.log('  [RAW]', line.trim());
      }
      if (/session/i.test(line) && /FA\s*\(/i.test(line)) {
        console.log('  [SESSION-DBG]', line.trim());
      }

      // Filtra linhas de outros apps (log.tag.FA VERBOSE é global do aparelho,
      // não por pacote). Só filtra quando dá pra extrair o PID da linha e o
      // pacote da marca está mapeado — sem isso, mantém o comportamento antigo.
      if (brandPackage) {
        const linePid = extractLinePid(line);
        if (linePid && !currentAppPids.has(linePid)) {
          if (SESSION_START_LINE_RE.test(line)) {
            // session_start é a única linha que legitimamente pode chegar com PID
            // ainda não sincronizado: ela é logada a poucos ms do cold start do
            // processo, antes do próximo tick de 1s do refreshAppPids. Em vez de
            // descartar direto, confirma na hora (só pra essa linha) se o PID é
            // mesmo do app da marca antes de aceitar.
            const freshPids = await getAppPids(adbPath, adbBaseArgs, brandPackage);
            if (!freshPids.includes(linePid)) continue;
            currentAppPids.add(linePid);
          } else if (!/FA-SVC/i.test(line)) {
            continue;
          }
          // Regra temporária de depuração (só screen_view): o dump multi-linha do FA-SVC
          // (usado por tryParseScreenViewMultiline) sai do processo do GMS/Play Services,
          // não do PID do app — não dá pra confirmar por pacote, então deixa passar sem
          // adicionar a currentAppPids. Remover esta exceção junto com as outras regras
          // temporárias quando a investigação terminar.
        }
      }

      // Detecção de SDKs de parceiros (única ocorrência por sessão)
      const partnerHit = parsePartnerLine(line);
      if (partnerHit && !partnersSeen.has(partnerHit.nome)) {
        partnersSeen.add(partnerHit.nome);
        try {
          await httpPost(`/api/mobile/ingest/${sessionId}`, partnerHit);
          console.log(`  [PARCEIRO] ${partnerHit.nome} (${partnerHit.categoria})`);
        } catch (e) { /* silencioso */ }
        continue;
      }

      // Regra temporária de depuração (só screen_view): reconstrói o evento a partir do
      // dump multi-linha do FA-SVC, quando o dispositivo não loga a linha única padrão.
      const multilineScreenView = tryParseScreenViewMultiline(line);
      if (multilineScreenView) {
        const pending = flutterQueue.get(multilineScreenView.event_name);
        if (pending) { clearTimeout(pending.timer); flutterQueue.delete(multilineScreenView.event_name); }
        faVerboseSeen.set(multilineScreenView.event_name, Date.now());
        await sendEvent(multilineScreenView);
        continue;
      }

      const event = parseFirebaseLine(line);
      if (!event) continue;

      if (event.event_name === 'session_start' && !event.params.brand) {
        event.params.brand = marca;
      }

      const now = Date.now();

      if (event._source === 'flutter_debug' || event._source === 'fa_svc') {
        const ts = faVerboseSeen.get(event.event_name);
        if (ts && now - ts < 2000) continue;
        // Aguarda 800ms: se FA VERBOSE chegar antes, cancela este
        const prev = flutterQueue.get(event.event_name);
        if (prev) clearTimeout(prev.timer);
        const captured = event;
        const timer = setTimeout(async () => {
          flutterQueue.delete(captured.event_name);
          const ts2 = faVerboseSeen.get(captured.event_name);
          if (ts2 && Date.now() - ts2 < 2000) return;
          await sendEvent(captured);
        }, 800);
        flutterQueue.set(event.event_name, { event, timer });
        continue;
      }

      if (event._source === 'fa_verbose' || event._source === 'fa_native') {
        const pending = flutterQueue.get(event.event_name);
        if (pending) {
          clearTimeout(pending.timer);
          flutterQueue.delete(event.event_name);
        }
        faVerboseSeen.set(event.event_name, now);
      }

      await sendEvent(event);
    }
  });

  console.log('  ✔ Captura iniciada — feche e reabra o app para capturar o session_start');

  // Varredura estática: detecta SDKs instalados no app via manifest
  const packageName = brandPackage;
  if (packageName) {
    console.log(`\n  Varrendo SDKs instalados em ${packageName}...`);
    const installedSdks = await scanInstalledSdks(adbPath, adbBaseArgs, packageName);
    if (installedSdks.length > 0) {
      for (const sdk of installedSdks) {
        try {
          await httpPost(`/api/mobile/ingest/${sessionId}`, sdk);
          console.log(`  [SDK INSTALADO] ${sdk.nome} (${sdk.categoria})`);
        } catch (e) { /* silencioso */ }
      }
      console.log(`  ✔ ${installedSdks.length} SDK(s) detectado(s) no manifesto`);
    } else {
      console.log('  ✔ Nenhum SDK de parceiro reconhecido no manifesto');
    }
  } else {
    console.log(`  ⚠ Marca "${marca}" sem package mapeado — varredura de SDKs ignorada`);
    console.log(`    Adicione em mobile/mobile-partners.json → "brands": { "${marca}": "com.pacote.app" }`);
  }
  console.log('');

  console.log('  Ouvindo eventos Firebase...');
  console.log('  Navegue pelo app e os eventos aparecerão aqui.');
  console.log('  Pressione Ctrl+C para finalizar a sessão.\n');

  // Polling para parada via dashboard (funciona local e remoto)
  const stopPoll = setInterval(async () => {
    try {
      const r = await fetch(`${SERVER_URL}/api/mobile/capture/should-stop/${sessionId}`);
      const { stop } = await r.json();
      if (stop) { clearInterval(stopPoll); process.emit('SIGINT'); }
    } catch {}
  }, 500);

  // Finaliza sessão no Ctrl+C
  process.on('SIGINT', async () => {
    clearInterval(stopPoll);
    clearInterval(pidRefreshInterval);
    console.log('\n\n  Finalizando sessão...');
    logcat.kill();
    // Flush flutter_debug events ainda aguardando FA VERBOSE
    for (const [name, { timer, event }] of flutterQueue) {
      clearTimeout(timer);
      const ts = faVerboseSeen.get(name);
      if (!ts || Date.now() - ts >= 2000) await sendEvent(event);
    }
    flutterQueue.clear();
    try {
      const result = await httpPost(`/api/mobile/session/stop/${sessionId}`, {});
      const s = result.summary || {};
      console.log('\n══════════════════════════════════════');
      console.log('  Resultado da sessão');
      console.log('══════════════════════════════════════');
      console.log(`  Status:              ${result.status === 'ok' ? '✔ OK' : '✖ HAS ERRORS'}`);
      console.log(`  Eventos capturados:  ${s.totalEvents || eventCount}`);
      console.log(`  Erros de validação:  ${s.validationErrors || 0}`);
      console.log(`  Inconsistências:     ${s.inconsistencies?.length || 0}`);
      if (s.parceirosInstalados?.length > 0) {
        console.log(`  SDKs instalados:     ${s.parceirosInstalados.map(p => p.nome).join(', ')}`);
      }
      if (s.parceirosAtivos?.length > 0) {
        console.log(`  SDKs ativos:         ${s.parceirosAtivos.map(p => p.nome).join(', ')}`);
      } else if (partnersSeen.size > 0) {
        console.log(`  SDKs ativos:         ${[...partnersSeen].join(', ')}`);
      }
      if (s.inconsistencies?.length > 0) {
        for (const ic of s.inconsistencies) {
          console.log(`    ⚠ item_id ${ic.item_id} — campo "${ic.field}" diverge entre eventos`);
        }
      }
      if (result.persisted) console.log(`  Salvo em:            ${result.persisted}`);
      if (ehEnderecoRede) console.log(`  Wi-Fi ADB ativo:     ${deviceTarget} (use "adb disconnect ${deviceTarget}" para encerrar)`);
      console.log(`\n  Dashboard: ${SERVER_URL}/mobile\n`);
    } catch (e) {
      console.error(`  ✖ Erro ao finalizar sessão: ${e.message}`);
    }
    process.exit(0);
  });
}

main();
