import { useState } from 'react'

const API = '/api/auth'

const DIAL_CODES = [
  { code: '+1',   label: '🇺🇸 +1  US/CA' },
  { code: '+44',  label: '🇬🇧 +44 UK' },
  { code: '+61',  label: '🇦🇺 +61 AU' },
  { code: '+64',  label: '🇳🇿 +64 NZ' },
  { code: '+33',  label: '🇫🇷 +33 FR' },
  { code: '+49',  label: '🇩🇪 +49 DE' },
  { code: '+39',  label: '🇮🇹 +39 IT' },
  { code: '+34',  label: '🇪🇸 +34 ES' },
  { code: '+31',  label: '🇳🇱 +31 NL' },
  { code: '+7',   label: '🇷🇺 +7  RU' },
  { code: '+81',  label: '🇯🇵 +81 JP' },
  { code: '+82',  label: '🇰🇷 +82 KR' },
  { code: '+86',  label: '🇨🇳 +86 CN' },
  { code: '+91',  label: '🇮🇳 +91 IN' },
  { code: '+52',  label: '🇲🇽 +52 MX' },
  { code: '+55',  label: '🇧🇷 +55 BR' },
  { code: '+65',  label: '🇸🇬 +65 SG' },
  { code: '+852', label: '🇭🇰 +852 HK' },
  { code: '+886', label: '🇹🇼 +886 TW' },
]

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

function PasswordStrength({ password }) {
  const checks = [
    { label: '8+ characters',    ok: password.length >= 8 },
    { label: 'Uppercase letter', ok: /[A-Z]/.test(password) },
    { label: 'Lowercase letter', ok: /[a-z]/.test(password) },
    { label: 'Number',           ok: /[0-9]/.test(password) },
    { label: 'Special character',ok: /[^A-Za-z0-9]/.test(password) },
  ]
  if (!password) return null
  return (
    <div style={{ display:'flex', flexWrap:'wrap', gap:'4px 10px', marginTop:6 }}>
      {checks.map(c => (
        <span key={c.label} style={{ fontSize:11, display:'flex', alignItems:'center', gap:3,
          color: c.ok ? 'var(--green)' : 'var(--text-muted)' }}>
          <i className={`ti ${c.ok ? 'ti-circle-check' : 'ti-circle'}`} aria-hidden="true"/>
          {c.label}
        </span>
      ))}
    </div>
  )
}

export default function Login({ onLogin }) {
  const [mode, setMode]               = useState('login') // 'login'|'signup'|'2fa-pick'|'2fa'
  const [username, setUsername]       = useState('')
  const [email, setEmail]             = useState('')
  const [phone, setPhone]             = useState('')
  const [dialCode, setDialCode]       = useState('+1')
  const [password, setPassword]       = useState('')
  const [confirm, setConfirm]         = useState('')
  const [code, setCode]               = useState('')
  const [tempId, setTempId]           = useState('')
  const [maskedEmail, setMaskedEmail] = useState('')
  const [maskedPhone, setMaskedPhone] = useState('')
  const [availableMethods, setAvailableMethods] = useState([])
  const [selectedMethod, setSelectedMethod]     = useState(null)
  const [error, setError]             = useState('')
  const [info, setInfo]               = useState('')
  const [loading, setLoading]         = useState(false)
  const [deviceId]                    = useState(getOrCreateDeviceId)

  const reset = () => { setError(''); setInfo('') }

  // ── Login submit ───────────────────────────────────────────────────────
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
        setMaskedEmail(data.maskedEmail || '')
        setMaskedPhone(data.maskedPhone || '')
        setAvailableMethods(data.availableMethods || ['email'])
        setLoading(false)
        if ((data.availableMethods || ['email']).length === 1) {
          // Only one method — auto-select and request code
          await requestMethod(data.tempId, data.availableMethods[0])
        } else {
          setMode('2fa-pick')
        }
        return
      }
      localStorage.setItem('caishen_token', data.token)
      onLogin({ token: data.token, user: data.user })
    } catch {
      setError('Cannot reach server — make sure npm start is running')
      setLoading(false)
    }
  }

  // ── Request 2FA code for chosen method ────────────────────────────────
  const requestMethod = async (tid, method) => {
    setSelectedMethod(method)
    setLoading(true); reset()
    try {
      const res  = await fetch(`${API}/2fa/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempId: tid, method })
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Failed to send code'); setLoading(false); return }
      setMode('2fa')
    } catch {
      setError('Cannot reach server')
    }
    setLoading(false)
  }

  // ── 2FA submit ─────────────────────────────────────────────────────────
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

  // ── Signup submit ──────────────────────────────────────────────────────
  const submitSignup = async (e) => {
    e.preventDefault()
    if (!username || !email || !password) { setError('Username, email, and password are required'); return }
    if (password !== confirm) { setError('Passwords do not match'); return }
    const phoneE164 = phone.trim() ? `${dialCode}${phone.replace(/\D/g, '')}` : ''
    if (phone.trim() && !/^\+[1-9]\d{6,14}$/.test(phoneE164)) {
      setError('Invalid phone number — enter digits only (e.g. 4155551234)'); return
    }
    setLoading(true); reset()
    try {
      const res  = await fetch(`${API}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password, phone: phoneE164 || undefined })
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Signup failed'); setLoading(false); return }
      setInfo('Account created! You can now sign in.')
      setMode('login')
      setPassword(''); setConfirm(''); setEmail(''); setPhone('')
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

  // ── Method picker screen ────────────────────────────────────────────────
  if (mode === '2fa-pick') {
    const methodMeta = {
      email: { icon: 'ti-mail', color: 'var(--blue)',   bg: 'var(--blue-light)',   label: 'Email code',        desc: `Send a code to ${maskedEmail}` },
      totp:  { icon: 'ti-lock', color: 'var(--purple)', bg: 'var(--purple-light)', label: 'Authenticator app', desc: 'Use Google Authenticator, Authy, etc.' },
    }
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', background:'var(--bg-primary)' }}>
        <div style={{ width:340 }}>
          {logoBlock}
          <div style={{ textAlign:'center', marginBottom:20 }}>
            <div style={{ width:48, height:48, borderRadius:12, background:'var(--amber-light)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px' }}>
              <i className="ti ti-shield-check" style={{ fontSize:24, color:'var(--amber)' }} aria-hidden="true"/>
            </div>
            <p style={{ fontSize:14, fontWeight:500, margin:'0 0 6px' }}>New device detected</p>
            <p style={{ fontSize:12, color:'var(--text-secondary)', margin:0 }}>Choose how you'd like to verify your identity</p>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {availableMethods.map(m => {
              const meta = methodMeta[m]
              if (!meta) return null
              return (
                <button key={m} onClick={() => requestMethod(tempId, m)} disabled={loading}
                  style={{ display:'flex', alignItems:'center', gap:14, padding:'14px 16px', background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', cursor:'pointer', textAlign:'left', transition:'border-color 0.15s' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = meta.color}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
                >
                  <div style={{ width:38, height:38, borderRadius:10, background:meta.bg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <i className={`ti ${meta.icon}`} style={{ fontSize:20, color:meta.color }} aria-hidden="true"/>
                  </div>
                  <div>
                    <div style={{ fontSize:13, fontWeight:500, color:'var(--text-primary)', marginBottom:2 }}>{meta.label}</div>
                    <div style={{ fontSize:11, color:'var(--text-secondary)' }}>{meta.desc}</div>
                  </div>
                  <i className="ti ti-chevron-right" style={{ marginLeft:'auto', color:'var(--text-muted)', fontSize:16 }} aria-hidden="true"/>
                </button>
              )
            })}
            {errorBox}
            <button type="button" onClick={() => { setMode('login'); reset(); setCode('') }}
              style={{ width:'100%', padding:'9px', background:'transparent', color:'var(--text-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', fontSize:13, cursor:'pointer', marginTop:2 }}>
              Back to sign in
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── 2FA code entry screen ───────────────────────────────────────────────
  if (mode === '2fa') {
    const isTotp = selectedMethod === 'totp'
    const iconMap = { totp: 'ti-lock', email: 'ti-device-mobile' }
    const colorMap= { totp: 'var(--purple)', email: 'var(--amber)' }
    const bgMap   = { totp: 'var(--purple-light)', email: 'var(--amber-light)' }
    const icon  = iconMap[selectedMethod]  || 'ti-device-mobile'
    const color = colorMap[selectedMethod] || 'var(--amber)'
    const bg    = bgMap[selectedMethod]    || 'var(--amber-light)'

    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', background:'var(--bg-primary)' }}>
        <div style={{ width:340 }}>
          {logoBlock}
          <div style={{ textAlign:'center', marginBottom:20 }}>
            <div style={{ width:48, height:48, borderRadius:12, background:bg, display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px' }}>
              <i className={`ti ${icon}`} style={{ fontSize:24, color }} aria-hidden="true"/>
            </div>
            <p style={{ fontSize:14, fontWeight:500, margin:'0 0 6px' }}>
              {isTotp ? 'Authenticator verification' : 'Verify your identity'}
            </p>
            <p style={{ fontSize:12, color:'var(--text-secondary)', margin:0, lineHeight:1.5 }}>
              {isTotp
                ? 'Enter the 6-digit code from your authenticator app'
                : <>A 6-digit code was sent to<br/><strong style={{ color:'var(--text-primary)' }}>{maskedEmail}</strong></>
              }
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
              {availableMethods.length > 1 && (
                <button type="button" onClick={() => { setMode('2fa-pick'); setCode(''); reset() }}
                  style={{ width:'100%', padding:'9px', background:'transparent', color:'var(--text-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', fontSize:13, cursor:'pointer' }}>
                  Use a different method
                </button>
              )}
              <button type="button" onClick={() => { setMode('login'); reset(); setCode('') }}
                style={{ width:'100%', padding:'9px', background:'transparent', color:'var(--text-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', fontSize:13, cursor:'pointer' }}>
                Back to sign in
              </button>
            </div>
          </form>
          <p style={{ textAlign:'center', fontSize:11, color:'var(--text-muted)', marginTop:16, lineHeight:1.5 }}>
            {isTotp
              ? 'Open Google Authenticator, Authy, or any TOTP app to find your code.'
              : 'Code expires in 10 minutes. This device will be remembered after verification.'
            }
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

        {/* ── Login form ──────────────────────────────────────────────── */}
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

        {/* ── Signup form ─────────────────────────────────────────────── */}
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
                <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>Email <span style={{ color:'var(--text-muted)', fontWeight:400 }}>(required for 2FA)</span></label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  style={{ width:'100%', padding:'10px 12px', fontSize:14 }}
                  autoComplete="email"/>
              </div>
              <div>
                <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>
                  Phone <span style={{ color:'var(--text-muted)', fontWeight:400 }}>(optional — enables SMS 2FA)</span>
                </label>
                <div style={{ display:'flex', gap:6 }}>
                  <select value={dialCode} onChange={e => setDialCode(e.target.value)}
                    style={{ padding:'10px 8px', fontSize:13, background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', color:'var(--text-primary)', cursor:'pointer', flexShrink:0 }}>
                    {DIAL_CODES.map(d => (
                      <option key={d.code} value={d.code}>{d.label}</option>
                    ))}
                  </select>
                  <input value={phone} onChange={e => setPhone(e.target.value)}
                    placeholder="4155551234"
                    style={{ flex:1, padding:'10px 12px', fontSize:14 }}
                    autoComplete="tel-national" inputMode="tel"/>
                </div>
                <p style={{ fontSize:11, color:'var(--text-muted)', margin:'4px 0 0' }}>Enter number without country code or spaces</p>
              </div>
              <div>
                <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="Min. 8 characters"
                  style={{ width:'100%', padding:'10px 12px', fontSize:14 }}
                  autoComplete="new-password"/>
                <PasswordStrength password={password}/>
              </div>
              <div>
                <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>Confirm password</label>
                <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
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
