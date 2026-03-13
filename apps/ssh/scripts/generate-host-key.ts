import { createHash, generateKeyPairSync } from 'node:crypto'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
const fingerprint = createHash('sha256').update(pem).digest('base64')

// Always print key to stdout - callers decide what to do with it.
// To save to disk:  pnpm run generate:host-key > keys/host_key
// To set on Fly:    fly secrets set HOST_KEY="$(pnpm run --silent generate:host-key:print)"
process.stdout.write(pem)
console.error(`SHA256:${fingerprint}`)
