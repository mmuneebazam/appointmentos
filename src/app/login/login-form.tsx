'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function LoginForm() {
  const router = useRouter()
  const [email, setEmail] = useState('owner@northside.test')
  const [password, setPassword] = useState('demo1234')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error?.message ?? 'Sign in failed')
        return
      }
      router.push('/dashboard')
      router.refresh()
    } catch {
      setError('Network error — is the server still running?')
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-3.5">
      <div>
        <label htmlFor="email" className="label mb-1.5 block">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          className="input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="password" className="label mb-1.5 block">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          className="input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      {error ? (
        <p className="rounded-lg border border-[#fecdca] bg-[#fef3f2] px-3 py-2 text-[12.5px] text-[#b42318]">
          {error}
        </p>
      ) : null}

      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
