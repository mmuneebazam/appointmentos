import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@/server/auth'
import { LoginForm } from './login-form'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  const user = await currentUser()
  if (user) redirect('/dashboard')

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-canvas)] px-6 py-12">
      <div className="w-full max-w-[400px]">
        <Link href="/" className="mb-6 flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-[15px] font-bold text-white">
            A
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-gray-900">AppointmentOS</span>
        </Link>

        <div className="card card-pad">
          <h1 className="text-[19px] font-semibold text-gray-900">Sign in</h1>
          <p className="mt-1 text-[13px] text-gray-500">
            Use a seeded demo account to explore the studio workspace.
          </p>
          <LoginForm />
        </div>

        <div className="mt-4 rounded-xl border border-dashed border-[var(--color-line)] bg-white/60 p-3.5">
          <p className="label">Demo accounts</p>
          <ul className="mt-1.5 space-y-1 font-mono text-[12px] text-gray-600">
            <li>owner@northside.test · demo1234</li>
            <li>manager@northside.test · demo1234</li>
            <li>jonas@northside.test · demo1234 (staff role)</li>
          </ul>
        </div>

        <p className="mt-5 text-center text-[12.5px] text-gray-500">
          Just here to book?{' '}
          <Link href="/book/northside" className="link">
            Open the public booking page
          </Link>
        </p>
      </div>
    </main>
  )
}
