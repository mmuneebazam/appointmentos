import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'AppointmentOS — multi-tenant booking & scheduling',
  description:
    'Multi-tenant appointment booking and staff scheduling platform with conflict-safe booking, deposits, calendar sync and durable notifications.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
