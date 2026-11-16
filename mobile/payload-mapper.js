const schema = require('./mobile-schema.json');

const FIREBASE_METHODS_TO_EVENT = {
  logViewItem: 'view_item',
  logAddToCart: 'add_to_cart',
  logViewItemList: 'view_item_list',
  logSelectItem: 'select_item',
  logBeginCheckout: 'begin_checkout',
  logAddShippingInfo: 'add_shipping_info',
  logAddPaymentInfo: 'add_payment_info',
  logPurchase: 'purchase',
  logViewCart: 'view_cart',
  logAddToWishlist: 'add_to_wishlist',
  logSearch: 'search',
  logViewPromotion: 'view_promotion',
  logSelectPromotion: 'select_promotion',
  logSelectContent: 'select_content',
};

const KNOWN_APP_EVENTS = new Set(Object.keys(schema.events));

// Regra temporária de depuração (par da mesma regra em mobile/adb-capture.js): mesmo
// vindo de log Flutter debug — que normalmente não carrega nenhum parâmetro —, não
// zera params pra este evento, pra investigar o que realmente chega no screen_view.
const DEBUG_KEEP_FLUTTER_PARAMS = new Set(['screen_view']);

function resolveEventName(event) {
  if (event.event_name) return event.event_name;
  if (event.firebaseMethod && FIREBASE_METHODS_TO_EVENT[event.firebaseMethod]) {
    return FIREBASE_METHODS_TO_EVENT[event.firebaseMethod];
  }
  if (event.event) return event.event;
  return null;
}

function isFirebaseHit(event) {
  if (event.isAnalyticsHit === true) return true;
  if (event.type === 'ga4') return true;
  if (event.event_name && event.params !== undefined) return true;
  if (event.firebaseMethod && FIREBASE_METHODS_TO_EVENT[event.firebaseMethod]) return true;
  return false;
}

function isDataLayerPush(event) {
  if (event.type === 'dl') return true;
  if (event.event && event.ecommerce !== undefined && !event.params) return true;
  return false;
}

function isPartnerEvent(event) {
  return event.type === 'partner';
}

// Parâmetros que existem pra alimentar integração de parceiro (AppsFlyer, Omnilogic,
// Insider, Meta/Facebook Pixel, etc.) e aparecem soltos no bundle do Firebase/GA4 sem
// estar declarados no schema de nenhum evento. Continuam aparecendo no relatório, só
// que como "parâmetro de parceiro" em vez de "não mapeado", pra não sugerir falsamente
// lacuna de schema.
const PARAMS_PARCEIRO_VISIVEL = new Set(['af_id', 'image_url', 'contents', 'total_items', 'item_name_variation']);

// Params numéricos que devem ser > 0
const POSITIVE_EVENT_PARAMS = new Set(['value', 'subtotal', 'installment_value']);
const POSITIVE_ITEM_PARAMS  = new Set(['price']);
// Params numéricos que devem ser >= 1
const MIN_ONE_EVENT_PARAMS  = new Set(['installments', 'total_items']);
const MIN_ONE_ITEM_PARAMS   = new Set(['quantity']);

function validateParamSemantic(paramName, value, source) {
  const typeMap = source === 'item' ? schema.itemParamTypes : schema.eventParamTypes;
  const expectedType = typeMap[paramName];
  const errors = [];
  const warnings = [];

  if (!expectedType) return { errors, warnings };

  if (expectedType === 'Number') {
    if (typeof value !== 'number' || isNaN(value)) {
      errors.push(`"${paramName}" deve ser Number, recebeu ${typeof value}: ${JSON.stringify(value)}`);
    } else {
      const positiveSet = source === 'item' ? POSITIVE_ITEM_PARAMS : POSITIVE_EVENT_PARAMS;
      const minOneSet   = source === 'item' ? MIN_ONE_ITEM_PARAMS  : MIN_ONE_EVENT_PARAMS;
      if (positiveSet.has(paramName) && value <= 0)
        warnings.push(`"${paramName}" = ${value} — esperado > 0`);
      if (minOneSet.has(paramName) && value < 1)
        warnings.push(`"${paramName}" = ${value} — esperado ≥ 1`);
      if (paramName === 'index' && (!Number.isInteger(value) || value < 0))
        warnings.push(`"${paramName}" = ${value} — esperado inteiro ≥ 0`);
    }
  } else if (expectedType === 'String') {
    if (typeof value !== 'string') {
      errors.push(`"${paramName}" deve ser String, recebeu ${typeof value}: ${JSON.stringify(value)}`);
    } else if (value === 'undefined' || value === 'null') {
      errors.push(`"${paramName}" = "${value}" — placeholder inválido, não o valor real`);
    }
  } else if (expectedType === 'Boolean') {
    if (typeof value !== 'boolean') {
      errors.push(`"${paramName}" deve ser Boolean, recebeu ${typeof value}: ${JSON.stringify(value)}`);
    }
  }

  return { errors, warnings };
}

// Nível A — enum estático global por parâmetro (specs/param-value-validation/01-nivel-a-enum.md)
// Nível B — valor esperado por sessão (specs/param-value-validation/02-nivel-b-sessao.md)
function validateParamValue(paramName, value, source, context) {
  const allowedMap = source === 'item' ? schema.itemParamAllowedValues : schema.eventParamAllowedValues;
  const allowedValues = allowedMap && allowedMap[paramName];
  const errors = [];
  const warnings = [];

  if (typeof value !== 'string') return { errors, warnings };
  const normalized = value.trim().toLowerCase();

  // Marcas isentas (ex.: marca-i é canal de escoamento do grupo e vende
  // marcas de fora do enum inteiro) pulam tanto o Nível A quanto o Nível B
  // para este parâmetro — não dá pra manter um enum fechado de marcas de terceiros.
  const binding = schema.paramContextBindings && schema.paramContextBindings[paramName];
  const marcaSessao = context && context.marca ? String(context.marca).trim().toLowerCase() : null;
  const isento = !!(binding && marcaSessao && (binding.exemptMarcas || []).some(m => m.toLowerCase() === marcaSessao));

  if (allowedValues && !isento) {
    const isAllowed = allowedValues.some(v => v.toLowerCase() === normalized);
    if (!isAllowed) {
      errors.push(`"${paramName}": valor "${value}" não está entre os aceitos (${allowedValues.join(', ')})`);
      return { errors, warnings }; // Nível B não roda em cima de um valor já reprovado no Nível A
    }
  }

  if (binding && context && !isento) {
    const expected = context[binding.field];
    if (expected !== undefined && expected !== null && expected !== '') {
      const canon = v => (schema.brandCanonical && schema.brandCanonical[v]) || v;
      const expectedNormalized = canon(String(expected).trim().toLowerCase());
      if (canon(normalized) !== expectedNormalized) {
        const refDescription = binding.source === 'screen' ? 'à tela atual' : 'à marca da sessão';
        const msg = `"${paramName}": valor "${value}" não corresponde ${refDescription} ("${expected}")`;
        if (binding.severity === 'warning') warnings.push(msg);
        else errors.push(msg);
      }
    }
  }

  return { errors, warnings };
}

function validateShippings(value, shippingItemSchema) {
  const errors = [];
  const warnings = [];

  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    errors.push('"shippings" contém JSON inválido — não foi possível parsear');
    return { errors, warnings };
  }

  if (!Array.isArray(parsed)) {
    errors.push('"shippings" deve ser um array de objetos de entrega');
    return { errors, warnings };
  }

  if (parsed.length === 0) {
    warnings.push('"shippings" é um array vazio');
    return { errors, warnings };
  }

  parsed.forEach((item, idx) => {
    const isPickup = typeof item.shipping_tier === 'string' && item.shipping_tier.toLowerCase().startsWith('retire na loja');
    for (const field of shippingItemSchema.required) {
      if (field === 'line_items' && isPickup) continue;
      const val = item[field];
      if (val === undefined || val === null || val === '') {
        errors.push(`shippings[${idx}]: campo obrigatório ausente: "${field}"`);
      } else {
        const expectedType = shippingItemSchema.types[field];
        if (expectedType === 'String' && typeof val !== 'string') {
          errors.push(`shippings[${idx}]: "${field}" deve ser String, recebeu ${typeof val}`);
        } else if (expectedType === 'Number' && typeof val !== 'number') {
          errors.push(`shippings[${idx}]: "${field}" deve ser Number, recebeu ${typeof val}`);
        }
      }
    }
  });

  return { errors, warnings };
}

function validateEventParams(eventName, params, items, context) {
  const eventSchema = schema.events[eventName];
  if (!eventSchema) return { valid: false, errors: [`Evento "${eventName}" não encontrado no schema mobile`], warnings: [] };

  const errors = [];
  const warnings = [];

  // Presença + semântica: params de evento obrigatórios
  for (const required of eventSchema.requiredEventParams) {
    const value = params[required];
    if (value === undefined || value === null || value === '') {
      errors.push(`Parâmetro obrigatório ausente: "${required}"`);
    } else {
      const sem = validateParamSemantic(required, value, 'event');
      errors.push(...sem.errors);
      warnings.push(...sem.warnings);
      const val = validateParamValue(required, value, 'event', context);
      errors.push(...val.errors);
      warnings.push(...val.warnings);
    }
  }

  // Semântica: params de evento opcionais que estão presentes
  for (const optional of eventSchema.optionalEventParams) {
    const value = params[optional];
    if (value !== undefined && value !== null && value !== '') {
      const sem = validateParamSemantic(optional, value, 'event');
      errors.push(...sem.errors);
      warnings.push(...sem.warnings);
      const val = validateParamValue(optional, value, 'event', context);
      errors.push(...val.errors);
      warnings.push(...val.warnings);
    }
  }

  // Presença + semântica: items
  if (eventSchema.requiredItemParams.length > 0) {
    if (!items || !Array.isArray(items) || items.length === 0) {
      errors.push('Array "items" obrigatório ausente ou vazio');
    } else {
      items.forEach((item, idx) => {
        for (const required of eventSchema.requiredItemParams) {
          const value = item[required];
          if (value === undefined || value === null || value === '') {
            errors.push(`Item[${idx}]: parâmetro obrigatório ausente: "${required}"`);
          } else {
            const sem = validateParamSemantic(required, value, 'item');
            errors.push(...sem.errors.map(e => `Item[${idx}]: ${e}`));
            warnings.push(...sem.warnings.map(w => `Item[${idx}]: ${w}`));
            const val = validateParamValue(required, value, 'item', context);
            errors.push(...val.errors.map(e => `Item[${idx}]: ${e}`));
            warnings.push(...val.warnings.map(w => `Item[${idx}]: ${w}`));
          }
        }
        for (const optional of (eventSchema.optionalItemParams || [])) {
          const value = item[optional];
          if (value !== undefined && value !== null && value !== '') {
            const sem = validateParamSemantic(optional, value, 'item');
            errors.push(...sem.errors.map(e => `Item[${idx}]: ${e}`));
            warnings.push(...sem.warnings.map(w => `Item[${idx}]: ${w}`));
            const val = validateParamValue(optional, value, 'item', context);
            errors.push(...val.errors.map(e => `Item[${idx}]: ${e}`));
            warnings.push(...val.warnings.map(w => `Item[${idx}]: ${w}`));
          }
        }
      });
    }
  }

  // Valida estrutura interna de shippings (string JSON serializada por limitação do Firebase)
  if (eventSchema.shippingItemSchema && params.shippings !== undefined && params.shippings !== null && params.shippings !== '') {
    const { errors: sErr, warnings: sWarn } = validateShippings(params.shippings, eventSchema.shippingItemSchema);
    errors.push(...sErr);
    warnings.push(...sWarn);
  }

  // Params não mapeados no schema
  const allKnownParams = new Set([
    ...eventSchema.requiredEventParams,
    ...eventSchema.optionalEventParams,
    ...(eventSchema.requiredItemParams || []),
    ...(eventSchema.optionalItemParams || []),
    'items',
  ]);
  for (const key of Object.keys(params)) {
    if (!allKnownParams.has(key)) {
      if (PARAMS_PARCEIRO_VISIVEL.has(key)) {
        warnings.push(`Parâmetro de parceiro: "${key}"`);
        continue;
      }
      warnings.push(`Parâmetro inesperado (não mapeado): "${key}"`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// O logcat não usa aspas — "item_id=89493" e "price=89493" são indistinguíveis.
// Esta função converte cada campo para o tipo definido no schema antes de validar,
// eliminando falsos positivos causados pelo parser ADB.
function coerceToSchemaTypes(params, items) {
  const coercedParams = {};
  for (const [key, val] of Object.entries(params)) {
    if (key === 'items') continue;
    const expected = schema.eventParamTypes[key];
    if (expected === 'String' && typeof val === 'number') {
      coercedParams[key] = String(val);
    } else if (expected === 'Number' && typeof val === 'string' && val !== '' && !isNaN(val)) {
      coercedParams[key] = Number(val);
    } else {
      coercedParams[key] = val;
    }
  }

  const coercedItems = items.map(item => {
    const out = {};
    for (const [key, val] of Object.entries(item)) {
      const expected = schema.itemParamTypes[key];
      if (expected === 'String' && typeof val === 'number') {
        out[key] = String(val);
      } else if (expected === 'Number' && typeof val === 'string' && val !== '' && !isNaN(val)) {
        out[key] = Number(val);
      } else {
        out[key] = val;
      }
    }
    return out;
  });

  coercedParams.items = coercedItems;
  return { coercedParams, coercedItems };
}

function normalizeFirebaseHit(event, context) {
  const eventName = resolveEventName(event);
  const rawParams = event.params || {};
  const rawItems = Array.isArray(rawParams.items) ? rawParams.items :
                   Array.isArray(event.items)     ? event.items     : [];
  const isFlutterDebug = event._source === 'flutter_debug';

  const { coercedParams, coercedItems } = coerceToSchemaTypes(rawParams, rawItems);

  const normalized = {
    event_name: eventName,
    params: { ...coercedParams, items: coercedItems },
    _meta: {
      source: isFlutterDebug ? 'flutter_debug' : 'firebase_sdk',
      originalType: event.type || 'ga4',
      knownEvent: KNOWN_APP_EVENTS.has(eventName),
    },
  };

  if (isFlutterDebug && !DEBUG_KEEP_FLUTTER_PARAMS.has(eventName)) {
    normalized.params = {};
    normalized._meta.validation = {
      valid: null,
      skipped: true,
      errors: [],
      warnings: ['Parâmetros não disponíveis via Flutter debug log — apenas o nome do evento foi capturado'],
    };
  } else if (eventName && KNOWN_APP_EVENTS.has(eventName)) {
    normalized._meta.validation = validateEventParams(eventName, coercedParams, coercedItems, context);
  }

  return normalized;
}

function normalizeDataLayerPush(event, context) {
  const eventName = event.event || resolveEventName(event);
  const ecommerce = event.ecommerce || {};
  const items = ecommerce.items || [];

  const normalized = {
    event: eventName,
    ecommerce,
    _meta: {
      source: 'datalayer',
      knownEvent: KNOWN_APP_EVENTS.has(eventName),
    },
  };

  if (eventName && KNOWN_APP_EVENTS.has(eventName)) {
    const params = { ...ecommerce };
    delete params.items;
    const validation = validateEventParams(eventName, params, items, context);
    normalized._meta.validation = validation;
  }

  return normalized;
}

const INCONSISTENCY_FIELDS = ['item_name', 'item_brand', 'price', 'item_sku', 'item_ref', 'item_variant'];

function detectInconsistencies(ga4Events, dlEvents) {
  const itemFieldValues = {};
  const itemNames = {};

  function processItem(item, eventName) {
    const itemId = item.item_id;
    if (!itemId) return;
    const name = item.item_name ?? item.parameters?.item_name;
    if (name && !itemNames[itemId]) itemNames[itemId] = name;
    for (const field of INCONSISTENCY_FIELDS) {
      const value = item[field] ?? item.parameters?.[field];
      if (value === undefined || value === null || value === '') continue;
      const key = `${itemId}::${field}`;
      if (!itemFieldValues[key]) itemFieldValues[key] = [];
      const alreadySeen = itemFieldValues[key].some(
        e => e.eventName === eventName && String(e.value) === String(value)
      );
      if (!alreadySeen) itemFieldValues[key].push({ value, eventName });
    }
  }

  for (const event of ga4Events) {
    const items = Array.isArray(event.params?.items) ? event.params.items : [];
    items.forEach(item => processItem(item, event.event_name));
  }
  for (const event of dlEvents) {
    const items = Array.isArray(event.ecommerce?.items) ? event.ecommerce.items : [];
    items.forEach(item => processItem(item, event.event));
  }

  const inconsistencies = [];
  for (const [key, entries] of Object.entries(itemFieldValues)) {
    const uniqueValues = [...new Set(entries.map(e => String(e.value)))];
    if (uniqueValues.length > 1) {
      const [itemId, field] = key.split('::');
      inconsistencies.push({
        item_id: itemId,
        item_name: itemNames[itemId] || null,
        field,
        values: entries.map(e => ({ event: e.eventName, value: e.value })),
      });
    }
  }
  return inconsistencies;
}

function normalizeMobileSession(mobileSessionData) {
  const dlEvents = [];
  const ga4Events = [];
  const parceiros = [];
  const unknownEvents = [];

  // Nível C: sessão já removida de session-manager.js quando este loop roda (finalizeSession
  // já apagou o estado) — currentRegion é rastreada localmente aqui em vez de via updateScreenContext.
  let currentRegion = null;

  for (const event of mobileSessionData.rawEvents) {
    if (isPartnerEvent(event)) {
      parceiros.push({ nome: event.nome, categoria: event.categoria, scanType: event.scanType || 'logcat' });
    } else if (isFirebaseHit(event)) {
      if (event.event_name === 'screen_view' && event.params && event.params.region) {
        currentRegion = event.params.region;
      }
      const context = { marca: mobileSessionData.marca, region: currentRegion };
      ga4Events.push(normalizeFirebaseHit(event, context));
    } else if (isDataLayerPush(event)) {
      const context = { marca: mobileSessionData.marca, region: currentRegion };
      dlEvents.push(normalizeDataLayerPush(event, context));
    } else {
      unknownEvents.push({
        ...event,
        _meta: { source: 'unknown', warning: 'Evento não classificado — verifique o formato do payload' },
      });
    }
  }

  const allValidations = [
    ...ga4Events.map(e => e._meta && e._meta.validation),
    ...dlEvents.map(e => e._meta && e._meta.validation),
  ].filter(v => v && !v.skipped);

  const totalErrors = allValidations.reduce((sum, v) => sum + v.errors.length, 0);
  const totalWarnings = allValidations.reduce((sum, v) => sum + v.warnings.length, 0);
  const inconsistencies = detectInconsistencies(ga4Events, dlEvents);

  const parceirosInstalados = parceiros.filter(p => p.scanType === 'static');
  const parceirosAtivos     = parceiros.filter(p => p.scanType !== 'static');

  return {
    marca: mobileSessionData.marca,
    dlEvents,
    ga4Events,
    parceiros,
    _summary: {
      totalEvents: mobileSessionData.rawEvents.filter(e => e.type !== 'partner').length,
      ga4Count: ga4Events.length,
      dlCount: dlEvents.length,
      unknownCount: unknownEvents.length,
      validationErrors: totalErrors,
      validationWarnings: totalWarnings,
      hasUnknownEvents: unknownEvents.length > 0,
      unknownEvents,
      inconsistencies,
      hasInconsistencies: inconsistencies.length > 0,
      parceirosInstalados,
      parceirosAtivos,
    },
  };
}

// ─── CONVERSÃO PARA O FORMATO QUE O validator.js ESPERA (dl-like) ────────────
// O Faro Web (área de saúde oficial) valida sessões de app rodando validator.js
// sobre uma versão "dl-like" dos ga4Events — mesmo contrato usado por ela em
// mobile/payload-mapper.js (adbEventToFaroDL). Reproduzido aqui pra sessões
// vindas do fluxo de streaming (start/ingest/stop) do Faro App, sem depender
// do arquivo dela.
function buildDlLikeFromGa4Events(ga4Events) {
  return ga4Events.map(ev => {
    const { items, ...rootParams } = ev.params || {};
    return {
      event: {
        event: ev.event_name,
        ...rootParams,
        ...(items ? { items, ecommerce: { items } } : {}),
      },
      timestamp:   ev.timestamp ?? Date.now(),
      _fromMobile: true,
    };
  });
}

module.exports = {
  normalizeMobileSession,
  normalizeFirebaseHit,
  normalizeDataLayerPush,
  isFirebaseHit,
  isDataLayerPush,
  isPartnerEvent,
  buildDlLikeFromGa4Events,
};
