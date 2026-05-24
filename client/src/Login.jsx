import { useState, useEffect } from 'react'

const API = '/api/auth'

function getOrCreateDeviceId() {
  let id = localStorage.getItem('caishen_device_id')
  if (!id) {
    id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`
    localStorage.setItem('caishen_device_id', id)
  }
  return id
}

export default function Login({ onLogin }) {
  const [mode, setMode]         = useState('login') // 'login' | 'signup' | '2fa'
  const [username, setUsername] = useState('')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [code, setCode]         = useState('')
  const [tempId, setTempId]     = useState('')
  const [maskedEmail, setMaskedEmail] = useState('')
  const [error, setError]       = useState('')
  const [info, setInfo]         = useState('')
  const [loading, setLoading]   = useState(false)
  const [deviceId]              = useState(getOrCreateDeviceId)

  const reset = () => { setError(''); setInfo('') }

  // ── Login submit ─────────────────────────────────────────────────────
  const submitLogin = async (e) => {
    e.preventDefault()
    if (!username || !password) { setError('Enter username and password'); return }
    setLoading(true); reset()
    try {
      const res  = await fetch(`${API}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, deviceId })
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Login failed'); setLoading(false); return }
      if (data.needs2FA) {
        setTempId(data.tempId)
        setMaskedEmail(data.maskedEmail)
        setMode('2fa')
        setLoading(false)
        return
      }
      localStorage.setItem('caishen_token', data.token)
      onLogin({ token: data.token, user: data.user })
    } catch {
      setError('Cannot reach server — make sure npm start is running')
      setLoading(false)
    }
  }

  // ── 2FA submit ────────────────────────────────────────────────────────
  const submit2FA = async (e) => {
    e.preventDefault()
    if (!code.trim()) { setError('Enter the verification code'); return }
    setLoading(true); reset()
    try {
      const res  = await fetch(`${API}/verify-2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempId, code: code.trim(), deviceId })
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Verification failed'); setLoading(false); return }
      localStorage.setItem('caishen_token', data.token)
      onLogin({ token: data.token, user: data.user })
    } catch {
      setError('Cannot reach server')
      setLoading(false)
    }
  }

  // ── Signup submit ─────────────────────────────────────────────────────
  const submitSignup = async (e) => {
    e.preventDefault()
    if (!username || !email || !password) { setError('All fields required'); return }
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    setLoading(true); reset()
    try {
      const res  = await fetch(`${API}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password })
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Signup failed'); setLoading(false); return }
      setInfo('Account created! You can now sign in.')
      setMode('login')
      setPassword(''); setConfirm(''); setEmail('')
      setLoading(false)
    } catch {
      setError('Cannot reach server')
      setLoading(false)
    }
  }

  const logoBlock = (
    <div style={{ textAlign:'center', marginBottom:28 }}>
      <div style={{ width:56, height:56, borderRadius:14, background:'var(--blue-light)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px' }}>
        <i className="ti ti-cash" style={{ fontSize:28, color:'var(--blue)' }} aria-hidden="true"/>
      </div>
      <h1 style={{ fontSize:21, fontWeight:600, margin:'0 0 3px', letterSpacing:'-0.5px' }}>CaiShen</h1>
      <p style={{ fontSize:13, color:'var(--text-secondary)', margin:0 }}>Personal Finance OS</p>
    </div>
  )

  const errorBox = error && (
    <div style={{ display:'flex', alignItems:'center', gap:8, padding:'9px 12px', background:'var(--coral-light)', borderRadius:'var(--radius-md)', fontSize:12, color:'var(--coral)', border:'0.5px solid var(--coral)' }}>
      <i className="ti ti-alert-circle" aria-hidden="true"/> {error}
    </div>
  )

  const infoBox = info && (
    <div style={{ display:'flex', alignItems:'center', gap:8, padding:'9px 12px', background:'var(--green-light)', borderRadius:'var(--radius-md)', fontSize:12, color:'var(--green)', border:'0.5px solid var(--green)' }}>
      <i className="ti ti-circle-check" aria-hidden="true"/> {info}
    </div>
  )

  // ── 2FA screen ────────────────────────────────────────────────────────
  if (mode === '2fa') {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', background:'var(--bg-primary)' }}>
        <div style={{ width:340 }}>
          {logoBlock}
          <div style={{ textAlign:'center', marginBottom:20 }}>
            <div style={{ width:48, height:48, borderRadius:12, background:'var(--amber-light)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px' }}>
              <i className="ti ti-device-mobile" style={{ fontSize:24, color:'var(--amber)' }} aria-hidden="true"/>
            </div>
            <p style={{ fontSize:14, fontWeight:500, margin:'0 0 6px' }}>New device detected</p>
            <p style={{ fontSize:12, color:'var(--text-secondary)', margin:0, lineHeight:1.5 }}>
              A 6-digit code was sent to<br/>
              <strong style={{ color:'var(--text-primary)' }}>{maskedEmail}</strong>
            </p>
          </div>
          <form onSubmit={submit2FA}>
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              <div>
                <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>Verification code</label>
                <input
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  placeholder="000000"
                  autoFocus
                  maxLength={6}
                  style={{ width:'100%', padding:'10px 12px', fontSize:20, textAlign:'center', letterSpacing:8 }}
                  autoComplete="one-time-code"
                />
              </div>
              {errorBox}
              <button type="submit" disabled={loading}
                style={{ width:'100%', padding:'11px', background:'var(--blue)', color:'#fff', border:'none', borderRadius:'var(--radius-md)', fontSize:14, fontWeight:500, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
                {loading ? <><i className="ti ti-loader-2 spin" aria-hidden="true"/> Verifying…</> : 'Verify & sign in'}
              </button>
              <button type="button" onClick={() => { setMode('login'); reset(); setCode('') }}
                style={{ width:'100%', padding:'9px', background:'transparent', color:'var(--text-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', fontSize:13, cursor:'pointer' }}>
                Back to sign in
              </button>
            </div>
          </form>
          <p style={{ textAlign:'center', fontSize:11, color:'var(--text-muted)', marginTop:16, lineHeight:1.5 }}>
            Code expires in 10 minutes. This device will be remembered after verification.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', background:'var(--bg-primary)' }}>
      <div style={{ width:340 }}>
        {logoBlock}

        {/* Tabs */}
        <div style={{ display:'flex', gap:2, marginBottom:24, borderBottom:'1.5px solid var(--border)', paddingBottom:0 }}>
          {[['login','Sign in'],['signup','Create account']].map(([m, label]) => (
            <button key={m} onClick={() => { setMode(m); reset() }}
              style={{
                flex:1, padding:'9px 0', fontSize:13, fontWeight: mode===m ? 600 : 400,
                cursor:'pointer', border:'none', background:'transparent',
                color: mode===m ? 'var(--text-primary)' : 'var(--text-muted)',
                borderBottom: mode===m ? '2px solid var(--blue)' : '2px solid transparent',
                marginBottom:'-1.5px', transition:'all 0.15s'
              }}>
              {label}
            </button>
          ))}
        </div>

        {infoBox && <div style={{ marginBottom:12 }}>{infoBox}</div>}

        {/* ── Login form ─────────────────────────────────────────────── */}
        {mode === 'login' && (
          <form onSubmit={submitLogin}>
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              <div>
                <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>Username</label>
                <input value={username} onChange={e => setUsername(e.target.value)}
                  placeholder="admin" autoFocus
                  style={{ width:'100%', padding:'10px 12px', fontSize:14 }}
                  autoComplete="username"/>
              </div>
              <div>
                <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  style={{ width:'100%', padding:'10px 12px', fontSize:14 }}
                  autoComplete="current-password"/>
              </div>
              {errorBox}
              <button type="submit" disabled={loading}
                style={{ width:'100%', padding:'11px', background:'var(--blue)', color:'#fff', border:'none', borderRadius:'var(--radius-md)', fontSize:14, fontWeight:500, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:6, marginTop:4 }}>
                {loading ? <><i className="ti ti-loader-2 spin" aria-hidden="true"/> Signing in…</> : 'Sign in'}
              </button>
            </div>
          </form>
        )}

        {/* ── Signup form ────────────────────────────────────────────── */}
        {mode === 'signup' && (
          <form onSubmit={submitSignup}>
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              <div>
                <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>Username</label>
                <input value={username} onChange={e => setUsername(e.target.value)}
                  placeholder="johndoe" autoFocus
                  style={{ width:'100%', padding:'10px 12px', fontSize:14 }}
                  autoComplete="username"/>
              </div>
              <div>
                <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>Email <span style={{ color:'var(--text-muted)', fontWeight:400 }}>(for 2FA)</span></label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  style={{ width:'100%', padding:'10px 12px', fontSize:14 }}
                  autoComplete="email"/>
              </div>
              <div>
                <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="Min. 8 characters"
                  style={{ width:'100%', padding:'10px 12px', fontSize:14 }}
                  autoComplete="new-password"/>
              </div>
              <div>
                <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>Confirm password</label>
                <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                  placeholder="••••••••"
                  style={{ width:'100%', padding:'10px 12px', fontSize:14 }}
                  autoComplete="new-password"/>
              </div>
              {errorBox}
              <button type="submit" disabled={loading}
                style={{ width:'100%', padding:'11px', background:'var(--blue)', color:'#fff', border:'none', borderRadius:'var(--radius-md)', fontSize:14, fontWeight:500, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:6, marginTop:4 }}>
                {loading ? <><i className="ti ti-loader-2 spin" aria-hidden="true"/> Creating account…</> : 'Create account'}
              </button>
            </div>
          </form>
        )}

        {mode === 'login' && (
          <p style={{ textAlign:'center', fontSize:11, color:'var(--text-muted)', marginTop:20, lineHeight:1.6 }}>
            Default login uses <strong>admin</strong> + <code style={{ fontSize:10 }}>MASTER_PASSWORD</code> from .env
          </p>
        )}
      </div>
    </div>
  )
}
