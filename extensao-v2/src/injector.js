// injector.js v14.8 — MAIN world, document_start
// Captura: dataLayer, GA4 via gtag interceptor + mb.listen, ações do usuário
// v14.3: captura parâmetros do preview GTM via dataLayer (mb.listen não captura preview)
// v14.3.1: remove origDataLayerPush duplicado que quebrava a cadeia de interceptação
// v14.4: merge buffer — combina hit do dataLayer::preview com hit do mb em vez de duplicar
// v14.8: filtra hits de destinos gtag não-GA4 (Google Ads etc) em sendBeacon/fetch/mb —
// tid ausente/não-G-, chave de destino AW-/DC-/UA-/GT-, e send_to/aw_remarketing_only
// dentro de mb::__root__ (que mistura mensagens de todos os destinos do container)

(function () {
  if (window.__dlCapture) return;
  window.__dlCapture    = true;
  window.__dlSeen       = new Set();
  window.__mbRegistered = new Set();
  window.__ga4Seen      = new Set();
  window.__captureQueue = { dl: [], ga4: [], actions: [] };

  // Domínio sGTM recebido do content.js após iniciar captura.
  // Preenchido via mensagem __faroSetSgtm para que sendBeacon/fetch
  // também interceptem hits que vão para o servidor sGTM customizado.
  let __sgtmDomain = '';
  window.addEventListener('message', (evt) => {
    if (evt.data?.__faroSetSgtm && typeof evt.data.sgtmDomain === 'string') {
      __sgtmDomain = evt.data.sgtmDomain;
    }
  });

  // Eventos GA4 conhecidos — usados para decidir se emite via dataLayer
  const GA4_EVENTOS = new Set([
    'page_view','search','login','sign_up','share',
    'view_item','view_item_list','select_item',
    'add_to_cart','remove_from_cart','view_cart',
    'begin_checkout','add_shipping_info','add_payment_info','purchase','refund',
    'view_promotion','select_promotion',
    'view_search_results',
    'generate_lead','tutorial_begin','tutorial_complete',
    'unlock_achievement','post_score','level_up','spend_virtual_currency',
  ]);

  // Chaves internas do GTM/dataLayer — removidas antes de emitir como GA4
  const CHAVES_INTERNAS = new Set([
    'event','gtm.uniqueEventId','gtm.start','gtm.scrollThreshold',
    'gtm.scrollUnits','gtm.scrollDirection','gtm.triggers',
    'isInteractive','eventModel',
  ]);

  // ── Merge buffer ────────────────────────────────────────────────────────────
  // Problema: dataLayer::preview e mb::__root__ emitem o mesmo evento separado.
  // dataLayer tem search_found (preview), mb tem event_id e outros params do GA4 publicado.
  // Solução: segurar o hit do dataLayer por 600ms. Se mb chegar nesse janela,
  // mergeia os dois (preview tem prioridade) e emite um único hit com _source:'merged'.
  // Se mb não chegar (ex: container só de preview), emite o dataLayer sozinho.
  const __mergeBuffer = {}; // eventName -> { params, timer }

  // Campos que o preview pode complementar quando o mb não capturar — ALLOWLIST
  // explícita, não "qualquer campo que sobrar". Um campo só entra aqui depois de
  // confirmado que o mb genuinamente não expõe ele mesmo quando o hit real de rede
  // o carrega (ex.: search_found — sabidamente ausente do mb mesmo indo pro GA4 de
  // verdade). Qualquer campo fora dessa lista que só o preview trouxer é DESCARTADO:
  // ele reflete o dataLayer cru, não o mapeamento real da tag configurada no GTM —
  // "completar" com ele foi a causa raiz do bug reportado em 19/08/2026 (line_items
  // aparecendo como se tivesse sido enviado pro GA4, quando a tag do GTM nunca inclui
  // esse parâmetro — o preview só ecoa o que o site empurrou pro dataLayer).
  const CAMPOS_PREVIEW_PODE_COMPLEMENTAR = new Set(['search_found']);

  function flushMergeBuffer(eventName) {
    const entry = __mergeBuffer[eventName];
    if (!entry) return;
    clearTimeout(entry.timer);
    delete __mergeBuffer[eventName];
    _emitGA4Final(eventName, entry.params, entry.source);
  }

  function emitGA4viaMerge(eventName, params, source) {
    // Hit do dataLayer::preview — guarda no buffer e aguarda o mb
    if (__mergeBuffer[eventName]) {
      // Já tem um hit pendente — mergeia imediatamente (raro, mesma busca dupla)
      __mergeBuffer[eventName].params = Object.assign({}, params, __mergeBuffer[eventName].params);
      return;
    }
    __mergeBuffer[eventName] = {
      params: { ...params },
      source,
      timer: setTimeout(() => {
        // mb não chegou no prazo — emite o dataLayer sozinho
        flushMergeBuffer(eventName);
      }, 600),
    };
  }

  function emitGA4viaMb(eventName, params, source) {
    const entry = __mergeBuffer[eventName];
    if (entry) {
      // Tem hit do dataLayer esperando — mergeia: mb é o hit real de rede, tem
      // prioridade em qualquer campo que os dois trouxerem. O preview só complementa
      // os campos da allowlist CAMPOS_PREVIEW_PODE_COMPLEMENTAR quando o mb não os
      // capturou — qualquer outro campo exclusivo do preview é descartado (reflete o
      // dataLayer cru, não o mapeamento real da tag — ver comentário na allowlist).
      const complemento = {};
      for (const campo of CAMPOS_PREVIEW_PODE_COMPLEMENTAR) {
        if (entry.params[campo] !== undefined && params[campo] === undefined) complemento[campo] = entry.params[campo];
      }
      const merged = Object.assign({}, complemento, params);
      clearTimeout(entry.timer);
      delete __mergeBuffer[eventName];
      _emitGA4Final(eventName, merged, 'merged');
    } else {
      // Não tem buffer — emite mb normalmente (sem preview ativo)
      _emitGA4Final(eventName, params, source);
    }
  }

  // ── Serialização segura ────────────────────────────────────────────────────
  function safeSerialize(obj) {
    try {
      return JSON.parse(JSON.stringify(obj, (key, val) => {
        if (val instanceof Node || val instanceof Window) return undefined;
        if (typeof val === 'function') return undefined;
        return val;
      }));
    } catch {
      const safe = {};
      for (const k of Object.keys(obj || {})) {
        const v = obj[k];
        if (v === null || ['string','number','boolean'].includes(typeof v)) safe[k] = v;
      }
      return safe;
    }
  }

  // ── Emit GA4 final (com deduplicação por event_id) ────────────────────────
  function _emitGA4Final(eventName, params, source) {
    if (!eventName || typeof eventName !== 'string') return;

    const IGNORAR_GA4 = ['gtm.js','gtm.dom','gtm.load','gtm.click','gtm.historyChange',
      'gtm.historyChange-v2','gtm.scrollDepth','gtm.timer','gtm.formSubmit','gtm.linkClick',
      'gtm.triggerGroup','gtm.pageview','optimize.activate'];
    if (IGNORAR_GA4.includes(eventName)) return;

    const key = params?.event_id ? `${eventName}::${params.event_id}` : null;
    if (key && window.__ga4Seen.has(key)) return;
    if (key) window.__ga4Seen.add(key);

    const hit = {
      event_name: eventName,
      params:     safeSerialize(params ?? {}),
      timestamp:  Date.now(),
      url:        window.location.href,
      _source:    source,
    };
    window.__captureQueue.ga4.push(hit);
    window.postMessage({ __ga4Hit: true, hit, timestamp: Date.now() }, '*');
  }

  // ── emitGA4 público — roteador por source ──────────────────────────────────
  function emitGA4(eventName, params, source) {
    if (source === 'dataLayer::preview') {
      emitGA4viaMerge(eventName, params, source);
    } else if (source && source.startsWith('mb::')) {
      emitGA4viaMb(eventName, params, source);
    } else {
      // gtag, sendBeacon, fetch — emite direto
      _emitGA4Final(eventName, params, source);
    }
  }

  // ── dataLayer interceptor ──────────────────────────────────────────────────
  window.dataLayer = window.dataLayer || [];
  const origPush = window.dataLayer.push.bind(window.dataLayer);
  window.dataLayer.push = function (...args) {
    const result = origPush(...args);
    args.forEach(ev => {
      if (ev && ev.event) {
        // ── Captura DL ──
        const idx = window.dataLayer.indexOf(ev);
        const key = idx >= 0 ? `dl::${idx}` : `dl::${ev.event}::${ev['gtm.uniqueEventId'] ?? Date.now()}`;
        if (!window.__dlSeen.has(key)) {
          window.__dlSeen.add(key);
          try {
            const safe = safeSerialize(ev);
            const item = { event: safe, timestamp: Date.now(), url: window.location.href };
            window.__captureQueue.dl.push(item);
            window.postMessage({ __dlCapture: true, payload: item }, '*');
          } catch {}
        }

        // ── Captura GA4 via dataLayer (preview GTM) ──────────────────────────
        // O mb.listen NÃO captura eventos do container de preview.
        // Quando o preview está ativo, os novos parâmetros chegam no dataLayer.push
        // mas não passam pelo mb.listen. Esta seção resolve isso via merge buffer.
        if (GA4_EVENTOS.has(ev.event)) {
          try {
            const safe = safeSerialize(ev);
            const params = {};
            for (const k of Object.keys(safe)) {
              if (!CHAVES_INTERNAS.has(k)) params[k] = safe[k];
            }
            emitGA4(ev.event, params, 'dataLayer::preview');
          } catch {}
        }
      }
    });
    return result;
  };

  // Snapshot fallback
  let lastLen = 0;
  setInterval(() => {
    const dl = window.dataLayer || [];
    for (let i = lastLen; i < dl.length; i++) {
      const ev = dl[i];
      if (ev && ev.event && typeof ev.event === 'string') {
        const key = `dl::${i}`;
        if (!window.__dlSeen.has(key)) {
          window.__dlSeen.add(key);
          try {
            const safe = safeSerialize(ev);
            const item = { event: safe, timestamp: Date.now(), url: window.location.href, _snapshot: true };
            window.__captureQueue.dl.push(item);
            window.postMessage({ __dlCapture: true, payload: item }, '*');
          } catch {}
        }
      }
    }
    lastLen = dl.length;
  }, 300);

  // ── GA4 via gtag interceptor ───────────────────────────────────────────────
  let _gtagFn = window.gtag;
  Object.defineProperty(window, 'gtag', {
    configurable: true,
    get() { return _gtagFn; },
    set(fn) {
      _gtagFn = function(...args) {
        try {
          if (args[0] === 'event' && args[1]) {
            emitGA4(args[1], args[2] ?? {}, 'gtag');
          }
        } catch {}
        return fn.apply(this, args);
      };
    }
  });

  // ── GA4 via sendBeacon interceptor ────────────────────────────────────────
  const origSendBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function(url, data) {
    try {
      const isSgtm = __sgtmDomain && url.includes(__sgtmDomain);
      if (isSgtm || url.includes('google-analytics.com') || url.includes('analytics.google.com')) {
        const processText = (text) => {
          if (!text) return;
          text.split('\n').forEach(line => {
            if (!line.trim()) return;
            try {
              const params = new URLSearchParams(line);
              const eventName = params.get('en');
              if (!eventName) return;
              // sGTM roteia GA4, Google Ads e outras tags Google pelo mesmo domínio/
              // formato de hit — só o "tid" diferencia (G- é GA4, AW- é Google Ads
              // etc). Sem esse filtro um hit de Google Ads com o mesmo event_name é
              // capturado como se fosse GA4.
              const tid = params.get('tid');
              if (!tid || !tid.startsWith('G-')) return;
              const paramObj = {};
              params.forEach((val, key) => {
                if (!['v','tid','gtm','cid','_s'].includes(key)) paramObj[key] = val;
              });
              emitGA4(eventName, paramObj, 'sendBeacon');
            } catch {}
          });
        };

        if (data instanceof Blob) {
          data.text().then(processText).catch(() => {});
        } else if (data instanceof ArrayBuffer) {
          processText(new TextDecoder().decode(data));
        } else if (typeof data === 'string') {
          processText(data);
        } else if (data instanceof URLSearchParams) {
          processText(data.toString());
        }
      }
    } catch {}
    return origSendBeacon(url, data);
  };

  // ── GA4 via fetch interceptor (fallback) ──────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function(...args) {
    try {
      const url = args[0]?.toString() ?? '';
      const isSgtm = __sgtmDomain && url.includes(__sgtmDomain);
      if (isSgtm || url.includes('google-analytics.com') || url.includes('analytics.google.com')) {
        const body = args[1]?.body;
        if (body && typeof body === 'string') {
          const params = new URLSearchParams(body);
          const eventName = params.get('en');
          const tid = params.get('tid');
          // Ver comentário equivalente no interceptor de sendBeacon acima.
          if (eventName && tid && tid.startsWith('G-')) {
            const paramObj = {};
            params.forEach((val, key) => {
              if (!['v','tid','gtm','cid','sid','sct','seg','_p','_s'].includes(key)) {
                paramObj[key] = val;
              }
            });
            emitGA4(eventName, paramObj, 'fetch');
          }
        }
      }
    } catch {}
    return origFetch.apply(this, args);
  };

  // ── GA4 via mb.listen (container publicado) ────────────────────────────────
  function registrarMbEmContainer(containerId, mb) {
    if (window.__mbRegistered.has(containerId)) return false;
    if (!mb || typeof mb.listen !== 'function') return false;
    window.__mbRegistered.add(containerId);
    mb.listen(function (msg) {
      try {
        const raw = msg?.message ?? msg;
        if (!raw || raw[0] !== 'event') return;
        const eventName = raw[1];
        const params    = raw[2] ?? {};
        if (!eventName || typeof eventName !== 'string') return;
        // 'mb::__root__' mistura mensagens de TODOS os destinos gtag do container,
        // não só GA4 — send_to apontando pra outro destino (ex: AW-...) ou o
        // marcador exclusivo do Google Ads Remarketing (aw_remarketing_only)
        // indicam que a mensagem não é um hit de GA4, mesmo com o mesmo event_name.
        // Achado real: marca-a, "purchase", 2026-09-09 — hit do Google Ads
        // Remarketing (send_to: "AW-990430687", aw_remarketing_only: true) sendo
        // capturado como se fosse o "purchase" do GA4 via mb::__root__ (o filtro por
        // chave de destino em registrarTodosContainers não cobre esse bus).
        if (params.send_to && !String(params.send_to).startsWith('G-')) return;
        if (params.aw_remarketing_only) return;
        emitGA4(eventName, params, 'mb::' + containerId);
      } catch {}
    });
    return true;
  }

  // O GTM registra cada destino gtag (G-..., AW-..., DC-... etc) como uma chave
  // própria dentro de window.google_tag_manager, cada uma com seu próprio "mb".
  // Prefixos abaixo são destinos Google conhecidos que NÃO são GA4 — escutar o mb
  // deles é exatamente como o hit do Google Ads (AW-990430687) virou "purchase"
  // do GA4 nesse container: mesmo event_name, schema completamente diferente.
  // '__root__' e chaves não reconhecidas (ex: GTM-XXXX, G-XXX) continuam sendo
  // registradas normalmente.
  const PREFIXOS_DESTINO_NAO_GA4 = ['AW-', 'DC-', 'UA-', 'GT-'];
  function ehDestinoNaoGA4(key) {
    return PREFIXOS_DESTINO_NAO_GA4.some(p => key.startsWith(p));
  }

  function registrarTodosContainers() {
    const gtm = window.google_tag_manager;
    if (!gtm) return false;
    let algumRegistrado = false;
    if (gtm.mb && registrarMbEmContainer('__root__', gtm.mb)) algumRegistrado = true;
    Object.keys(gtm).forEach(key => {
      if (ehDestinoNaoGA4(key)) return;
      const container = gtm[key];
      if (!container || typeof container !== 'object') return;
      const mb = container.mb || container?.dataLayer?.mb;
      if (mb && registrarMbEmContainer(key, mb)) algumRegistrado = true;
    });
    return algumRegistrado;
  }

  let mbTick = 0;
  const mbIv = setInterval(() => {
    mbTick++;
    registrarTodosContainers();
    if (mbTick > 100) clearInterval(mbIv);
  }, 200);

  // ── Janela cega do início da página ────────────────────────────────────────
  // O polling de 200ms acima só ataca o mb depois que o GTM existe. Entre o GTM
  // processar um evento em hit de GA4 e o próximo tique, o hit é invisível — e como o
  // gancho do dataLayer é imediato (document_start), o evento aparece no DL e some no
  // GA4. Achado real: auth_action da Marca I, que dispara logo após o redirect do
  // login; o Tag Assistant mostrava o hit enviado e o Faro acusava "não chegou ao GA4".
  // Agrava em marcas onde a interceptação de rede não contribui (Marca I: 100% das
  // capturas vêm do mb::__root__), porque ali não existe segundo caminho.
  //
  // Aqui a janela encolhe de ~200ms para ~10ms: assim que o GTM é atribuído, roda uma
  // varredura densa. Não basta registrar na atribuição — o GTM cria o objeto antes de
  // popular o `mb` dentro dele, então é preciso insistir por alguns instantes.
  // É ADITIVO de propósito: o intervalo de 200ms acima continua intacto como rede de
  // segurança (destinos que o GTM adiciona depois, e ambientes onde defineProperty falhe).
  function varreduraDensa() {
    let t = 0;
    const iv = setInterval(() => {
      t++;
      registrarTodosContainers();
      if (t > 300) clearInterval(iv); // ~3s a 10ms
    }, 10);
  }

  try {
    if (window.google_tag_manager) {
      registrarTodosContainers();
      varreduraDensa();
    } else {
      let _gtmInterno;
      Object.defineProperty(window, 'google_tag_manager', {
        configurable: true,
        enumerable: true,
        get() { return _gtmInterno; },
        set(v) {
          _gtmInterno = v;
          try { registrarTodosContainers(); varreduraDensa(); } catch {}
        },
      });
    }
  } catch {}

  // ── GTM Preview — injeta parâmetros quando ativado pelo content.js ─────────
  window.addEventListener('message', (evt) => {
    if (!evt.data?.__gtmPreview) return;
    const { gtm_auth, gtm_preview, gtm_cookies_win } = evt.data.gtmPreview ?? {};
    if (!gtm_auth || !gtm_preview) return;
    try {
      document.cookie = `gtm_preview=${gtm_preview};path=/`;
      document.cookie = `gtm_auth=${gtm_auth};path=/`;
      document.cookie = `gtm_cookies_win=${gtm_cookies_win || 'x'};path=/`;
      const url = new URL(window.location.href);
      url.searchParams.set('gtm_auth', gtm_auth);
      url.searchParams.set('gtm_preview', gtm_preview);
      url.searchParams.set('gtm_cookies_win', gtm_cookies_win || 'x');
      window.history.replaceState({}, '', url.toString());
      const gtmScripts = document.querySelectorAll('script[src*="googletagmanager.com/gtm.js"]');
      gtmScripts.forEach(script => {
        const src = new URL(script.src);
        src.searchParams.set('gtm_auth', gtm_auth);
        src.searchParams.set('gtm_preview', gtm_preview);
        src.searchParams.set('gtm_cookies_win', gtm_cookies_win || 'x');
        const newScript = document.createElement('script');
        newScript.src = src.toString();
        newScript.onload = () => {
          setTimeout(() => registrarTodosContainers(), 100);
          setTimeout(() => registrarTodosContainers(), 500);
          setTimeout(() => registrarTodosContainers(), 1500);
        };
        document.head.appendChild(newScript);
      });
      window.postMessage({ __gtmPreviewAtivo: true, gtm_preview }, '*');
      console.log('[Faro] GTM Preview ativo:', gtm_preview);
    } catch (e) {
      console.warn('[Faro] Erro ao ativar preview GTM:', e.message);
    }
  });


  // ── Interceptação de parceiros ────────────────────────────────────────────
  // Captura chamadas reais para pixels e SDKs de parceiros com os valores resolvidos
  window.__parceirosCapture = window.__parceirosCapture || [];
  window.__parceirosSeen    = window.__parceirosSeen    || new Set();

  function emitParceiro(parceiro, evento, payload) {
    try {
      const key = parceiro + '::' + evento + '::' + JSON.stringify(payload).slice(0, 100);
      if (window.__parceirosSeen.has(key)) return;
      window.__parceirosSeen.add(key);
      const hit = {
        parceiro, evento,
        payload:   safeSerialize(payload ?? {}),
        timestamp: Date.now(),
        url:       window.location.href,
      };
      window.__parceirosCapture.push(hit);
      window.postMessage({ __parceiro: true, hit }, '*');
    } catch {}
  }

  // ── Meta Pixel (fbq) ──────────────────────────────────────────────────────
  (function interceptFbq() {
    let _fbq = window.fbq;
    Object.defineProperty(window, 'fbq', {
      configurable: true,
      get() { return _fbq; },
      set(fn) {
        _fbq = function(...args) {
          try {
            const cmd = args[0]; // 'track', 'trackCustom', 'init'
            if (['track','trackCustom','trackSingle','trackSingleCustom'].includes(cmd)) {
              emitParceiro('Meta Pixel', args[1] ?? cmd, args[2] ?? {});
            }
          } catch {}
          return fn.apply(this, args);
        };
        if (!_fbq.push) _fbq.push = _fbq;
        if (!_fbq.loaded) _fbq.loaded = true;
        if (!_fbq.version) _fbq.version = '2.0';
        if (!_fbq.queue) _fbq.queue = [];
      }
    });
    // Se fbq já está definido, envolve direto
    if (typeof window.fbq === 'function' && !window.fbq.__faroWrapped) {
      const orig = window.fbq;
      window.fbq = function(...args) {
        try {
          if (['track','trackCustom','trackSingle','trackSingleCustom'].includes(args[0])) {
            emitParceiro('Meta Pixel', args[1] ?? args[0], args[2] ?? {});
          }
        } catch {}
        return orig.apply(this, args);
      };
      window.fbq.__faroWrapped = true;
      Object.assign(window.fbq, orig);
    }
  })();

  // ── TikTok Pixel (ttq) ────────────────────────────────────────────────────
  (function interceptTtq() {
    function wrapTtq(obj) {
      if (!obj || obj.__faroWrapped) return obj;
      const orig = obj.track?.bind(obj);
      if (orig) {
        obj.track = function(event, params) {
          emitParceiro('TikTok', event, params ?? {});
          return orig(event, params);
        };
        obj.__faroWrapped = true;
      }
      return obj;
    }
    let _ttq = window.ttq;
    if (_ttq) wrapTtq(_ttq);
    Object.defineProperty(window, 'ttq', {
      configurable: true,
      get() { return _ttq; },
      set(v) { _ttq = wrapTtq(v); }
    });
  })();

  // ── Pinterest (pintrk) ────────────────────────────────────────────────────
  (function interceptPintrk() {
    let _pintrk = window.pintrk;
    function wrapPintrk(fn) {
      if (!fn || fn.__faroWrapped) return fn;
      const wrapped = function(...args) {
        try {
          if (args[0] === 'track') emitParceiro('Pinterest', args[1], args[2] ?? {});
        } catch {}
        return fn.apply(this, args);
      };
      wrapped.__faroWrapped = true;
      Object.assign(wrapped, fn);
      return wrapped;
    }
    if (_pintrk) _pintrk = wrapPintrk(_pintrk);
    Object.defineProperty(window, 'pintrk', {
      configurable: true,
      get() { return _pintrk; },
      set(v) { _pintrk = wrapPintrk(v); }
    });
  })();

  // ── Criteo (criteo_q / window.Criteo) ─────────────────────────────────────
  (function interceptCriteo() {
    // Criteo usa array de comandos: window.criteo_q = window.criteo_q || []
    // e depois criteo_q.push({ event: 'viewItem', item: '...' })
    const origArr = window.criteo_q;
    window.criteo_q = new Proxy(origArr ?? [], {
      get(target, prop) {
        if (prop === 'push') {
          return function(...args) {
            args.forEach(cmd => {
              try {
                if (cmd && cmd.event) emitParceiro('Criteo', cmd.event, cmd);
              } catch {}
            });
            return Array.prototype.push.apply(target, args);
          };
        }
        return target[prop];
      }
    });
  })();

  // ── RTB House ─────────────────────────────────────────────────────────────
  // RTB House usa rtbhouse.sendEvent() ou pixel via URL (img/script tag)
  // Intercepta o objeto rtbhouse e também fetch/beacon para o domínio deles
  (function interceptRtbHouse() {
    function wrapRtb(obj) {
      if (!obj || obj.__faroWrapped) return obj;
      ['sendEvent','track'].forEach(method => {
        const orig = obj[method]?.bind(obj);
        if (orig) {
          obj[method] = function(event, params) {
            emitParceiro('RTB House', event, params ?? {});
            return orig(event, params);
          };
        }
      });
      obj.__faroWrapped = true;
      return obj;
    }
    let _rtb = window.rtbhouse;
    if (_rtb) wrapRtb(_rtb);
    Object.defineProperty(window, 'rtbhouse', {
      configurable: true,
      get() { return _rtb; },
      set(v) { _rtb = wrapRtb(v); }
    });
  })();

  // ── Bing/Microsoft Ads (uetq) ─────────────────────────────────────────────
  (function interceptUetq() {
    const origArr = window.uetq;
    window.uetq = new Proxy(origArr ?? [], {
      get(target, prop) {
        if (prop === 'push') {
          return function(...args) {
            args.forEach(cmd => {
              try {
                if (cmd && cmd.ea) emitParceiro('Bing Ads', cmd.ea, cmd);
                else if (cmd && typeof cmd === 'object') emitParceiro('Bing Ads', cmd.gv ?? 'event', cmd);
              } catch {}
            });
            return Array.prototype.push.apply(target, args);
          };
        }
        return target[prop];
      }
    });
  })();

  // ── Insider ───────────────────────────────────────────────────────────────
  (function interceptInsider() {
    function wrapInsider(obj) {
      if (!obj || obj.__faroWrapped) return obj;
      const orig = obj.track?.bind(obj);
      if (orig) {
        obj.track = function(event, params) {
          emitParceiro('Insider', event, params ?? {});
          return orig(event, params);
        };
        obj.__faroWrapped = true;
      }
      return obj;
    }
    let _insider = window.Insider;
    if (_insider) wrapInsider(_insider);
    Object.defineProperty(window, 'Insider', {
      configurable: true,
      get() { return _insider; },
      set(v) { _insider = wrapInsider(v); }
    });
  })();

  // ── Dito ──────────────────────────────────────────────────────────────────
  (function interceptDito() {
    function wrapDito(obj) {
      if (!obj || obj.__faroWrapped) return obj;
      const orig = obj.track?.bind(obj);
      if (orig) {
        obj.track = function(payload) {
          try { emitParceiro('Dito', payload?.action ?? 'track', payload?.data ?? payload); } catch {}
          return orig(payload);
        };
        obj.__faroWrapped = true;
      }
      return obj;
    }
    let _dito = window.dito;
    if (_dito) wrapDito(_dito);
    Object.defineProperty(window, 'dito', {
      configurable: true,
      get() { return _dito; },
      set(v) { _dito = wrapDito(v); }
    });
  })();

  // ── Google Ads via gtag (já interceptado acima via gtag) ──────────────────
  // Captura chamadas gtag('event', ...) para Google Ads (send_to com AW-)
  const _origEmitGA4 = emitGA4;
  // Monkey-patch: detecta AW- no send_to e duplica como parceiro
  const __origGtagSet = Object.getOwnPropertyDescriptor(window, 'gtag');
  if (__origGtagSet) {
    const prevSet = __origGtagSet.set;
    if (prevSet) {
      Object.defineProperty(window, 'gtag', {
        configurable: true,
        get: __origGtagSet.get,
        set(fn) {
          prevSet.call(this, function(...args) {
            try {
              if (args[0] === 'event' && args[2]?.send_to && String(args[2].send_to).includes('AW-')) {
                emitParceiro('Google Ads', args[1], args[2]);
              }
            } catch {}
            return fn.apply(this, args);
          });
        }
      });
    }
  }


  // ── Polling de parceiros já inicializados ────────────────────────────────
  // Fallback para SDKs que carregam antes do injector ou via GTM após document_start
  function tentarWrapParceiros() {
    // Meta Pixel — fbq já definido mas não wrapped
    if (window.fbq && !window.fbq.__faroWrapped) {
      const orig = window.fbq;
      window.fbq = function(...args) {
        try {
          if (['track','trackCustom','trackSingle','trackSingleCustom'].includes(args[0])) {
            emitParceiro('Meta Pixel', args[1] ?? args[0], args[2] ?? {});
          }
        } catch {}
        return orig.apply(this, args);
      };
      window.fbq.__faroWrapped = true;
      Object.assign(window.fbq, orig);
    }

    // TikTok — ttq já definido
    if (window.ttq && !window.ttq.__faroWrapped) {
      const orig = window.ttq.track?.bind(window.ttq);
      if (orig) {
        window.ttq.track = function(event, params) {
          emitParceiro('TikTok', event, params ?? {});
          return orig(event, params);
        };
        window.ttq.__faroWrapped = true;
      }
    }

    // Pinterest — pintrk já definido
    if (window.pintrk && !window.pintrk.__faroWrapped) {
      const orig = window.pintrk;
      window.pintrk = function(...args) {
        try { if (args[0] === 'track') emitParceiro('Pinterest', args[1], args[2] ?? {}); } catch {}
        return orig.apply(this, args);
      };
      window.pintrk.__faroWrapped = true;
      Object.assign(window.pintrk, orig);
    }

    // Dito — dito já definido
    if (window.dito && !window.dito.__faroWrapped) {
      const orig = window.dito.track?.bind(window.dito);
      if (orig) {
        window.dito.track = function(payload) {
          try { emitParceiro('Dito', payload?.action ?? 'track', payload?.data ?? payload); } catch {}
          return orig(payload);
        };
        window.dito.__faroWrapped = true;
      }
    }

    // Insider — Insider já definido
    if (window.Insider && !window.Insider.__faroWrapped) {
      const orig = window.Insider.track?.bind(window.Insider);
      if (orig) {
        window.Insider.track = function(event, params) {
          emitParceiro('Insider', event, params ?? {});
          return orig(event, params);
        };
        window.Insider.__faroWrapped = true;
      }
    }

    // RTB House — rtbhouse já definido
    if (window.rtbhouse && !window.rtbhouse.__faroWrapped) {
      ['sendEvent','track'].forEach(method => {
        const orig = window.rtbhouse[method]?.bind(window.rtbhouse);
        if (orig) {
          window.rtbhouse[method] = function(event, params) {
            emitParceiro('RTB House', event, params ?? {});
            return orig(event, params);
          };
        }
      });
      window.rtbhouse.__faroWrapped = true;
    }
  }

  // Drena filas históricas dos SDKs que já dispararam antes do wrap
  function drenaFilasHistoricas() {
    try {
      // Meta Pixel — fbq.queue tem os eventos disparados antes do wrap
      if (window.fbq?.queue?.length) {
        window.fbq.queue.forEach(args => {
          try {
            if (['track','trackCustom','trackSingle','trackSingleCustom'].includes(args[0])) {
              emitParceiro('Meta Pixel', args[1] ?? args[0], args[2] ?? {});
            }
          } catch {}
        });
        window.fbq.queue = []; // limpa para não duplicar
      }
      // Criteo — criteo_q é o array de comandos
      if (Array.isArray(window.criteo_q)) {
        window.criteo_q.forEach(cmd => {
          try { if (cmd?.event) emitParceiro('Criteo', cmd.event, cmd); } catch {}
        });
      }
    } catch {}
  }

  // Tenta imediatamente e depois a cada 500ms por 15s
  tentarWrapParceiros();
  drenaFilasHistoricas();
  let _parceiroTick = 0;
  const _parceiroIv = setInterval(() => {
    tentarWrapParceiros();
    drenaFilasHistoricas();
    _parceiroTick++;
    if (_parceiroTick > 30) clearInterval(_parceiroIv);
  }, 500);

  // ── Captura de ações do usuário ────────────────────────────────────────────
  function emitAction(action) {
    window.__captureQueue.actions.push(action);
    window.postMessage({ __userAction: true, action }, '*');
  }

  // Gera seletor estável para reprodução — mesma lógica de QA tools (Cypress, Playwright Recorder)
  function gerarSeletorEstavel(el) {
    try {
      // 1. label[for] — tamanhos VTEX (mais estável, único por SKU)
      if (el.tagName === 'LABEL' && el.htmlFor) {
        return { sel: 'label[for="' + el.htmlFor + '"]', tipo: 'tamanho' };
      }
      // Sobe para label pai (clique no span dentro do label)
      const labelPai = el.closest('label[data-variant]');
      if (labelPai && labelPai.htmlFor) {
        return { sel: 'label[for="' + labelPai.htmlFor + '"]', tipo: 'tamanho' };
      }

      // 2. button de carrinho VTEX — usa data-item-id (SKU unico por card) como seletor primario
      const btnCart = el.closest('button[data-cart-item]');
      if (btnCart) {
        const itemId = btnCart.getAttribute('data-item-id');
        if (itemId) return { sel: 'button[data-item-id="' + itemId + '"]', tipo: 'carrinho', itemId };
        const cartItem = btnCart.getAttribute('data-cart-item');
        if (cartItem) return { sel: 'button[data-cart-item="' + cartItem.slice(0, 150) + '"]', tipo: 'carrinho' };
      }

      // 3. button[data-variant] — botão de ação VTEX
      const btnVariant = el.closest('button[data-variant]');
      if (btnVariant) {
        const txt = (btnVariant.innerText || '').trim().slice(0, 50);
        if (txt) return { sel: 'button[data-variant="true"]', texto: txt, tipo: 'botao' };
      }

      // 4. a[href] — banner, produto, menu, categoria
      const anchor = el.closest('a[href]');
      if (anchor && anchor.href) {
        return { sel: null, href: anchor.href, tipo: 'link' };
      }

      // 5. button com texto único — fallback para botões sem data-*
      const btn = el.closest('button');
      if (btn) {
        const txt = (btn.innerText || btn.textContent || '').trim().slice(0, 50);
        if (txt) return { sel: null, texto: txt, tipo: 'botao' };
      }

      // 6. data-testid
      const testEl = el.closest('[data-testid]') || el.closest('[data-test-id]');
      if (testEl) {
        const tid = testEl.getAttribute('data-testid') || testEl.getAttribute('data-test-id');
        return { sel: '[data-testid="' + tid + '"]', tipo: 'testid' };
      }

    } catch {}
    return { sel: null, tipo: 'desconhecido' };
  }

  document.addEventListener('click', (e) => {
    try {
      const el  = e.target;
      const img = el.tagName === 'IMG' ? el : el.querySelector('img');

      // Detecta o elemento semântico e gera seletor estável
      const seletorInfo = gerarSeletorEstavel(el);
      const anchor = el.closest('a[href]');

      // Coleta data-* do elemento semântico (não do target cru)
      let dataAttrs = null;
      try {
        const semEl = el.closest('button') || el.closest('label') || el.closest('a') || el;
        const da = {};
        if (semEl.attributes) {
          for (let i = 0; i < semEl.attributes.length; i++) {
            const a = semEl.attributes[i];
            if (a.name.startsWith('data-') && !a.name.includes('gtm') && a.value) {
              da[a.name] = a.value.slice(0, 100);
            }
          }
        }
        if (Object.keys(da).length > 0) dataAttrs = da;
      } catch {}

      emitAction({
        type: 'click', timestamp: Date.now(), url: window.location.href,
        x: Math.round((e.clientX / window.innerWidth)  * 10000) / 100,
        y: Math.round((e.clientY / window.innerHeight) * 10000) / 100,
        href:        seletorInfo.href || anchor?.href || null,
        text:        seletorInfo.texto || (el.innerText || el.textContent || '').trim().slice(0, 80) || null,
        imgSrc:      img?.src || img?.dataset?.src || null,
        tag:         el.tagName?.toLowerCase(),
        ariaLabel:   el.getAttribute('aria-label') || anchor?.getAttribute('aria-label') || null,
        dataTestId:  el.dataset?.testid || el.dataset?.testId || null,
        cssSelector: seletorInfo.sel || null,
        clickTipo:   seletorInfo.tipo || null,
        dataAttrs,
      });
    } catch {}
  }, true);

  let lastUrl = window.location.href;
  const checkUrl = () => {
    if (window.location.href !== lastUrl) {
      emitAction({ type: 'navigation', url: window.location.href, from: lastUrl, timestamp: Date.now() });
      lastUrl = window.location.href;
    }
  };
  setInterval(checkUrl, 500);
  window.addEventListener('popstate', checkUrl);
  window.addEventListener('pushstate', checkUrl);

  let lastScrollPct = 0;
  window.addEventListener('scroll', () => {
    try {
      const pct = Math.round((window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100);
      if (Math.abs(pct - lastScrollPct) >= 25) {
        emitAction({ type: 'scroll', y: pct, timestamp: Date.now(), url: window.location.href });
        lastScrollPct = pct;
      }
    } catch {}
  }, { passive: true });

  // ── Captura de digitação em campos de busca ────────────────────────────────
  // Emite ação 'type' com debounce de 600ms (aguarda o usuário parar de digitar)
  // + ação 'key_enter' quando o usuário pressiona Enter para confirmar a busca
  const inputTimers = new WeakMap();

  document.addEventListener('input', (e) => {
    try {
      const el = e.target;
      if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) return;

      // Só captura campos de texto/busca
      const type = (el.type || '').toLowerCase();
      if (!['text', 'search', ''].includes(type)) return;

      // Debounce — aguarda 600ms sem digitar antes de emitir
      if (inputTimers.has(el)) clearTimeout(inputTimers.get(el));
      inputTimers.set(el, setTimeout(() => {
        try {
          emitAction({
            type:      'type',
            timestamp: Date.now(),
            url:       window.location.href,
            value:     el.value,
            selector:  el.name || el.id || el.className?.split(' ')[0] || null,
            tag:       el.tagName.toLowerCase(),
            ariaLabel: el.getAttribute('aria-label') || el.getAttribute('placeholder') || null,
          });
        } catch {}
      }, 600));
    } catch {}
  }, true);

  // Captura Enter no campo — dispara busca sem novo debounce
  document.addEventListener('keydown', (e) => {
    try {
      if (e.key !== 'Enter') return;
      const el = e.target;
      if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
      const type = (el.type || '').toLowerCase();
      if (!['text', 'search', ''].includes(type)) return;

      // Cancela debounce pendente e emite imediatamente com o valor atual
      if (inputTimers.has(el)) { clearTimeout(inputTimers.get(el)); inputTimers.delete(el); }
      emitAction({
        type:      'type',
        timestamp: Date.now(),
        url:       window.location.href,
        value:     el.value,
        selector:  el.name || el.id || el.className?.split(' ')[0] || null,
        tag:       el.tagName.toLowerCase(),
        ariaLabel: el.getAttribute('aria-label') || el.getAttribute('placeholder') || null,
        trigger:   'enter',
      });
    } catch {}
  }, true);

})();
