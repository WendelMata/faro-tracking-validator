import { useState, useEffect, useRef } from 'react'
import axios from 'axios'

// Tela de login do Faro. Pergunta ao servidor se a autenticação é exigida (FARO_API_TOKEN) e
// se esta sessão já está autenticada; se não, pede o token e troca por um cookie HttpOnly.
// Qualquer 401 posterior (cookie expirado, 12 h) devolve o usuário para esta tela.
export default function LoginGate({ children }) {
  const [estado, setEstado] = useState('carregando') // carregando | login | ok
  const [token, setToken] = useState('')
  const [erro, setErro] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [google, setGoogle] = useState(null) // { clientId, domain } quando o login Google está ativo
  const gbtn = useRef(null)

  useEffect(() => {
    axios.get('/api/auth/status')
      .then(r => {
        if (r.data.googleClientId) setGoogle({ clientId: r.data.googleClientId, domain: r.data.googleDomain })
        setEstado(r.data.required && !r.data.authenticated ? 'login' : 'ok')
      })
      .catch(() => setEstado('ok')) // servidor sem a rota (versão antiga): não bloqueia
    const id = axios.interceptors.response.use(r => r, e => {
      if (e.response?.status === 401 && !String(e.config?.url).startsWith('/api/auth/')) setEstado('login')
      return Promise.reject(e)
    })
    return () => axios.interceptors.response.eject(id)
  }, [])

  // Login Google: carrega o Google Identity Services e desenha o botão.
  useEffect(() => {
    if (estado !== 'login' || !google) return
    const iniciar = () => {
      window.google.accounts.id.initialize({
        client_id: google.clientId,
        hd: google.domain,
        callback: async resp => {
          try {
            await axios.post('/api/auth/google', { credential: resp.credential })
            setEstado('ok')
          } catch (e) {
            setErro(e.response?.status === 429 ? 'Muitas tentativas. Aguarde um minuto.' : (e.response?.data?.error || 'Login negado.'))
          }
        },
      })
      if (gbtn.current) window.google.accounts.id.renderButton(gbtn.current, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'pt-BR' })
    }
    if (window.google?.accounts?.id) return iniciar()
    const sc = document.createElement('script')
    sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.onload = iniciar
    document.head.appendChild(sc)
  }, [estado, google])

  async function entrar(ev) {
    ev.preventDefault()
    setErro(''); setEnviando(true)
    try {
      await axios.post('/api/auth/login', { token: token.trim() })
      setToken(''); setEstado('ok')
    } catch (e) {
      setErro(e.response?.status === 429 ? 'Muitas tentativas. Aguarde um minuto.' : 'Token inválido.')
    } finally { setEnviando(false) }
  }

  if (estado === 'carregando') return null
  if (estado === 'ok') return children

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#0f1e35', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <form onSubmit={entrar} style={{ width: 340, background: '#fff', borderRadius: 12, padding: 28, boxShadow: '0 10px 40px rgba(0,0,0,.35)' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 20, color: '#0f172a' }}>FARO</h1>
        {google && (
          <>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: '#475569' }}>Entre com sua conta corporativa.</p>
            <div ref={gbtn} style={{ minHeight: 44 }} />
            <div style={{ margin: '16px 0', textAlign: 'center', fontSize: 12, color: '#94a3b8' }}>ou</div>
          </>
        )}
        <p style={{ margin: '0 0 12px', fontSize: 13, color: '#475569' }}>Informe o token de acesso fornecido pelo time de Data Tracking.</p>
        <label htmlFor="faro-token" style={{ fontSize: 12, fontWeight: 600, color: '#334155' }}>Token de acesso</label>
        <input id="faro-token" type="password" autoFocus={!google} autoComplete="off" value={token}
          onChange={e => setToken(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', margin: '6px 0 12px', padding: '9px 10px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14 }} />
        {erro && <div role="alert" style={{ color: '#b91c1c', fontSize: 13, marginBottom: 10 }}>{erro}</div>}
        <button type="submit" disabled={!token.trim() || enviando}
          style={{ width: '100%', padding: '10px', border: 0, borderRadius: 8, background: '#2563eb', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', opacity: !token.trim() || enviando ? .6 : 1 }}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  )
}
