import { useRef, useState } from 'react'
import './health-theme.css'
import ThemeToggle from './ThemeToggle'
import FullscreenToggle from './FullscreenToggle'
import { isEventoPrincipal, corPorPct, PARAMS_PRINCIPAIS } from './eventos-principais'

// "com aviso": evento disparou certo mas tem parâmetro com problema — mesmo conceito
// já usado na visão geral, aplicado por evento aqui também.
const eventoComAviso = e => e.status === 'correto' && (e.erros ?? []).length > 0
const corEvento = e => eventoComAviso(e) ? 'var(--wh-warn)' : e.status === 'correto' ? 'var(--wh-ok)' : e.status === 'ausente' ? 'var(--wh-decoration)' : 'var(--wh-error)'

function badgeDoEvento(e) {
  const comAviso = eventoComAviso(e)
  if (comAviso) return { cls: 'wh-badge-warn', txt: 'com aviso' }
  if (e.status === 'correto') return { cls: 'wh-badge-ok', txt: 'OK' }
  if (e.status === 'ausente') return { cls: 'wh-badge-na', txt: 'ausente' }
  return { cls: 'wh-badge-error', txt: 'erro' }
}

function TabelaEventos({ titulo, lista }) {
  if (!lista.length) return null
  return (
    <div style={{ marginBottom: 24 }}>
      <div className="wh-section-title">{titulo}</div>
      <div className="wh-panel">
        <div className="wh-table-wrap">
          <table className="wh-table">
            <thead>
              <tr><th>Evento</th><th>Região</th><th>Status</th><th>Cobertura</th><th>Erros / observações</th></tr>
            </thead>
            <tbody>
              {lista.map((e, i) => {
                const badge = badgeDoEvento(e)
                return (
                  <tr key={`${e.evento}-${e.regiao}-${i}`}>
                    <td>{e.evento}</td>
                    <td>{e.regiao || '—'}</td>
                    <td><span className={`wh-badge ${badge.cls}`}>{badge.txt}</span></td>
                    <td>{e.cobertura}%</td>
                    <td style={{ textAlign: 'left', color: eventoComAviso(e) ? 'var(--wh-warn)' : 'var(--wh-muted)', fontSize: 12, fontWeight: eventoComAviso(e) ? 600 : 400 }}>
                      {(e.erros ?? []).length > 0 ? e.erros.join(', ') : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default function HealthMarca({ marcaAtiva, healthLoading, healthResultLoading, healthResult, onBack }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('webHealthTheme') || 'light')
  const pageRef = useRef(null)

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('webHealthTheme', next)
  }

  const marcaLabel = marcaAtiva?.name || marcaAtiva?.id || ''

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <button className="wh-back" onClick={onBack}>← Voltar</button>
      <div style={{ display: 'flex', gap: 8 }}>
        <FullscreenToggle targetRef={pageRef} />
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>
    </div>
  )

  if (healthLoading || healthResultLoading) {
    return (
      <div className="web-health-page" data-theme={theme} ref={pageRef}>
        {header}
        <div className="wh-loading">Carregando análise de saúde...</div>
      </div>
    )
  }

  if (!healthResult) {
    return (
      <div className="web-health-page" data-theme={theme} ref={pageRef}>
        {header}
        <div className="wh-detail-header">
          <div>
            <div className="wh-detail-title">{marcaLabel}</div>
            <div className="wh-detail-sub">Sem sessão de referência</div>
          </div>
        </div>
        <div className="wh-empty">
          <div className="wh-empty-title">Nenhuma sessão de saúde definida</div>
          <div style={{ fontSize: 13, color: 'var(--wh-muted)', lineHeight: 1.6 }}>
            Vá em <strong>Sessões de Extensão</strong>, grave uma jornada completa e defina como sessão de saúde.
          </div>
        </div>
      </div>
    )
  }

  const { score, corretos, comAviso, ausentes, erros, porRegiao, schema: sc, sessao, eventos: eventosResult, parametrosPrincipais } = healthResult
  const eventos = eventosResult ?? []
  const principais = eventos.filter(isEventoPrincipal)
  const demais = eventos.filter(e => !isEventoPrincipal(e)).slice().sort((a, b) => a.cobertura - b.cobertura)
  const avisos = eventos.filter(e => e.aviso)

  // Mesmo padrão do App (mobile/dashboard.html): a cobertura de "Parâmetros" considera só
  // os 6 campos curados (item_name, item_id, item_sku, item_ref, price, value) sobre os
  // eventos principais — não o schema inteiro. userId/email entram na lista porque
  // custom_user_info só existe no Web (ver PARAMS_PRINCIPAIS em eventos-principais.js).
  const parametrosResult = (parametrosPrincipais ?? []).filter(p => PARAMS_PRINCIPAIS.includes(p.name))
  const pctParams = parametrosResult.length > 0
    ? Math.round(parametrosResult.reduce((s, p) => s + (p.cobertura ?? 0), 0) / parametrosResult.length)
    : 0

  const totalEventosStatus = corretos + comAviso + ausentes + erros || 1
  const faixasEventos = [
    { label: 'Corretos', color: 'var(--wh-ok)', count: corretos },
    { label: 'Com aviso', color: 'var(--wh-warn)', count: comAviso },
    { label: 'Ausentes', color: 'var(--wh-decoration)', count: ausentes },
    { label: 'Com erro', color: 'var(--wh-error)', count: erros },
  ]

  const principaisRanked = [...principais].sort((a, b) => b.cobertura - a.cobertura)

  return (
    <div className="web-health-page" data-theme={theme} ref={pageRef}>
      {header}

      <div className="wh-detail-header">
        <div>
          <div className="wh-detail-title">{marcaLabel}</div>
          <div className="wh-detail-sub">Sessão de referência: {sessao?.nome || '—'}{sessao?.timestamp ? ` · ${new Date(sessao.timestamp).toLocaleString('pt-BR')}` : ''} · schema v{sc?.version} · {sc?.total} eventos</div>
        </div>
      </div>

      {avisos.length > 0 && (
        <div className="wh-warning-banner">
          <div>
            <div className="wh-warning-title">Dados coletados incompatíveis com o schema</div>
            <div className="wh-warning-body">
              {avisos.length} evento(s) dispararam com parâmetro <strong>region</strong> diferente do esperado pelo schema.
              Isso pode indicar que a implementação está enviando o evento para a região errada.
            </div>
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {avisos.slice(0, 5).map((e, i) => <span className="wh-warning-chip" key={i}>{e.evento}: {e.aviso}</span>)}
              {avisos.length > 5 && <span style={{ fontSize: 11, color: 'var(--wh-warn)' }}>+{avisos.length - 5} mais</span>}
            </div>
          </div>
        </div>
      )}

      <div className="wh-kpis">
        <div className="wh-kpi-card">
          <div className="wh-kpi-label">Saúde geral</div>
          <div className="wh-kpi-value" style={{ color: corPorPct(score) }}>{score}%</div>
        </div>
        <div className="wh-kpi-card">
          <div className="wh-kpi-label">Parâmetros</div>
          <div className="wh-kpi-value" style={{ color: corPorPct(pctParams) }}>{pctParams}%</div>
          <div className="wh-kpi-sub">Cobertura média dos parâmetros</div>
        </div>
        <div className="wh-kpi-card">
          <div className="wh-kpi-label">Eventos avaliados</div>
          <div className="wh-kpi-value">{eventos.length}</div>
        </div>
      </div>

      <div className="wh-grid">
        <div className="wh-panel">
          <div className="wh-panel-title">Cobertura dos eventos principais</div>
          <div className="wh-panel-pad">
            {principaisRanked.length === 0 ? (
              <div style={{ padding: '8px 0', color: 'var(--wh-muted)', fontSize: 12 }}>Nenhum evento principal aplicável a esta marca.</div>
            ) : principaisRanked.map((e, i) => {
              const cor = corEvento(e)
              return (
                <div className="wh-rank-row" key={`${e.evento}-${i}`} title={`${eventoComAviso(e) ? 'com aviso' : e.status}${(e.erros || []).length ? ' · ' + e.erros.join(', ') : ''}`}>
                  <span className="wh-rank-name">{e.evento}{e.regiao ? <span className="regiao"> {e.regiao}</span> : null}</span>
                  <div className="wh-rank-track"><div className="wh-rank-fill" style={{ width: `${e.cobertura}%`, background: cor }} /></div>
                  <span className="wh-rank-pct" style={{ color: cor }}>{e.cobertura}%</span>
                </div>
              )
            })}
          </div>
        </div>
        <div className="wh-panel">
          <div className="wh-panel-title">Eventos por status</div>
          <div className="wh-panel-pad">
            {faixasEventos.map(f => (
              <div className="wh-status-row" key={f.label}>
                <span className="wh-status-label"><span className="wh-dot" style={{ background: f.color }} />{f.label}</span>
                <span className="wh-status-count" style={{ color: f.color }}>{f.count}</span>
              </div>
            ))}
            <div className="wh-status-bar">
              {faixasEventos.filter(f => f.count > 0).map(f => (
                <div key={f.label} style={{ width: `${(f.count / totalEventosStatus) * 100}%`, background: f.color }} />
              ))}
            </div>
          </div>
        </div>
      </div>

      <TabelaEventos titulo="Eventos Principais" lista={principais} />
      <TabelaEventos titulo="Demais Eventos" lista={demais} />

      {(parametrosResult ?? []).length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div className="wh-section-title">Parâmetros</div>
          <div className="wh-panel">
            <div className="wh-table-wrap">
              <table className="wh-table">
                <thead><tr><th>Parâmetro</th><th>Cobertura</th></tr></thead>
                <tbody>
                  {parametrosResult.map(p => (
                    <tr key={p.name}>
                      <td>{p.name}</td>
                      <td style={{ color: corPorPct(p.cobertura), fontWeight: 700 }}>{p.cobertura}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {Object.entries(porRegiao ?? {}).map(([regiao, eventosRegiao]) => {
        const regCorr = eventosRegiao.filter(e => e.status === 'correto').length
        const regPct = eventosRegiao.length > 0 ? Math.round((regCorr / eventosRegiao.length) * 100) : 0
        return (
          <div className="wh-panel" key={regiao} style={{ marginBottom: 14 }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--wh-border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--wh-ink)' }}>{regiao}</div>
              <span className={`wh-badge ${regPct === 100 ? 'wh-badge-ok' : regPct >= 70 ? 'wh-badge-warn' : 'wh-badge-error'}`}>{regPct}%</span>
            </div>
            <div className="wh-table-wrap">
              <table className="wh-table">
                <thead><tr><th>Evento</th><th>Status</th><th>Region (disparo)</th><th>Erros / observações</th></tr></thead>
                <tbody>
                  {eventosRegiao.map(ev => {
                    const badge = badgeDoEvento(ev)
                    return (
                      <tr key={ev.evento}>
                        <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{ev.evento}</td>
                        <td>
                          <span className={`wh-badge ${badge.cls}`}>{badge.txt}</span>
                          {ev.status !== 'ausente' && <span style={{ color: 'var(--wh-muted)', marginLeft: 4, fontSize: 11 }}>×{ev.ocorrencias}</span>}
                        </td>
                        <td>
                          {ev.regionReal
                            ? <span style={{ fontSize: 11, color: 'var(--wh-accent)' }}>{ev.regionReal}</span>
                            : ev.status === 'ausente' || !(ev.erros ?? []).some(e => e.startsWith('region:'))
                              ? <span style={{ color: 'var(--wh-decoration)' }}>—</span>
                              : <span style={{ color: 'var(--wh-warn)', fontSize: 11 }}>region ausente</span>}
                        </td>
                        <td style={{ textAlign: 'left', color: 'var(--wh-muted)', fontSize: 11 }}>
                          {ev.erros?.length > 0 ? ev.erros.slice(0, 3).map((e, j) => <div key={j} style={{ color: 'var(--wh-error)' }}>{e}</div>) : (ev.status !== 'ausente' && <span style={{ color: 'var(--wh-ok)' }}>—</span>)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}
