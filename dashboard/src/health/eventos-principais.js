// Mesma lista + mesmas regras de região de "eventos principais" usadas nos dois cálculos
// desta área (visão geral e detalhe por marca) — fonte única, evita duplicar a regra.
// "user_info" entrou por pedido da equipe em 12/08 — só no Web (o App mantém a lista
// original, em mobile/dashboard.html, deliberadamente fora de sincronia aqui).
export const EVENTOS_PRINCIPAIS = ['session_start', 'view_item_list', 'select_item', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'user_info']

export function isEventoPrincipal(e) {
  if (!EVENTOS_PRINCIPAIS.includes(e.evento)) return false
  if (e.evento === 'view_item_list') return (e.regiao ?? '').toLowerCase() === 'pdc'
  if (e.evento === 'add_to_cart') return ['pdc', 'pdp'].includes((e.regiao ?? '').toLowerCase())
  if (e.evento === 'select_item') return (e.regiao ?? '').toLowerCase() === 'pdc'
  return true
}

export function corPorPct(pct) {
  return pct >= 90 ? 'var(--wh-ok)' : pct >= 70 ? 'var(--wh-warn)' : 'var(--wh-error)'
}

// Parâmetros principais avaliados sobre os eventos principais — igual ao App: a coluna
// "Parâmetros" mostra a cobertura só desses campos quando o filtro está em "Eventos
// principais", em vez da cobertura de todos os parâmetros do schema. "userId" e
// "email" (user_info) entraram por pedido da equipe — o server.js soma essas duas
// entradas em parametrosPrincipais especificamente pro Web (ver calcularScoreSessao/
// health-session em server.js), já que user_info não tem entrada no schema.json pra
// passar pelo cálculo padrão. Não são só "customer.userId"/"customer.email" — cada
// marca usa um campo diferente pro mesmo dado (marca-a/Marca E só têm customer.id;
// Marca E também tem um userId dentro de address), então o server.js já aceita
// qualquer um desses e reporta só como "userId"/"email" aqui.
export const PARAMS_PRINCIPAIS = ['item_name', 'item_id', 'item_sku', 'item_ref', 'price', 'value', 'userId', 'email']
