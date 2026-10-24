import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'

/**
 * Build a throwaway SQLite database for the suite. Tests must never touch the
 * demo database — a reviewer should be able to run `npm test` mid-demo without
 * destroying the data they were showing.
 */
export default function setup() {
  const dbPath = path.resolve(__dirname, '../prisma/test.db')
  rmSync(dbPath, { force: true })
  process.env.DATABASE_URL = 'file:./test.db?connection_limit=1'
  execSync('npx prisma db push --skip-generate --force-reset', {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: 'file:./test.db?connection_limit=1' },
    stdio: 'pipe',
  })
}
