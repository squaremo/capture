let clientPromise

function getClient() {
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) return null
  if (!clientPromise) {
    clientPromise = import('@1password/sdk').then(({ createClient }) =>
      createClient({
        auth: process.env.OP_SERVICE_ACCOUNT_TOKEN,
        integrationName: 'capture',
        integrationVersion: '1.0.0',
      })
    )
  }
  return clientPromise
}

// Resolves an env var by name. An `op://...` value is fetched from 1Password
// via a Service Account; any other value (including undefined) passes
// through unchanged, so 1Password is entirely optional.
export async function resolveEnv(name) {
  const value = process.env[name]
  if (!value?.startsWith('op://')) return value

  const client = await getClient()
  if (!client) {
    throw new Error(`${name} is an op:// reference but OP_SERVICE_ACCOUNT_TOKEN is not set`)
  }
  return client.secrets.resolve(value)
}
