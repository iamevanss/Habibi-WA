// pair.js
// Standalone WhatsApp pairing for Habibi — run this in Termux, not on Railway.
//
// It never touches Supabase and never touches the deployed bot while it
// runs: it pairs using its own local auth state (a "pair_auth" folder),
// then once the connection opens and settles, it prints one SESSION_ID
// string built from the exact { creds, ...keys } shape that
// lib/supabase.js's importSessionString() already knows how to decode.
//
// Usage:
//   git clone <your repo>
//   cd Habibi-WA-main
//   npm install        (already installs everything this needs — baileys
//                        and @hapi/boom, both already in package.json /
//                        baileys' own dependencies — nothing new to add)
//   node pair.js
//
// Paste the printed string into Railway as the SESSION_ID env var and
// redeploy. index.js and lib/supabase.js need zero changes.

import { execSync } from 'node:child_process'
import readline from 'node:readline'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  BufferJSON
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'

const AUTH_FOLDER = './pair_auth'

// Hold a wake lock so Android doesn't freeze Termux mid-pairing/sync.
try {
  execSync('termux-wake-lock')
  console.log('Wake lock acquired — Termux will stay awake while this runs.')
} catch {
  console.log('Could not acquire wake lock (not running in Termux?) — continuing anyway.')
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (question) => new Promise((resolve) => rl.question(question, resolve))

let asked = false
let exported = false
let exportTimer = null

// Wraps useMultiFileAuthState so every key Baileys ever sets is also
// mirrored into a plain in-memory bundle, keyed exactly the way
// lib/supabase.js's own keystore keys them ("${type}-${id}"). This avoids
// depending on how useMultiFileAuthState names files on disk — the bundle
// is built straight from the same (type, id) pairs Baileys hands to
// keys.set, so the exported keys are guaranteed to match what the
// receiving side will later ask for.
async function useTrackedAuthState(folder) {
  const { state, saveCreds } = await useMultiFileAuthState(folder)
  const bundle = {}

  const originalSet = state.keys.set
  state.keys.set = async (data) => {
    await originalSet(data)
    for (const type in data) {
      for (const id in data[type]) {
        const value = data[type][id]
        const bundleKey = `${type}-${id}`
        if (value) bundle[bundleKey] = value
        else delete bundle[bundleKey]
      }
    }
  }

  return { state, saveCreds, bundle }
}

function buildSessionString(state, bundle) {
  const full = { creds: state.creds, ...bundle }
  const json = JSON.stringify(full, BufferJSON.replacer)
  return Buffer.from(json, 'utf8').toString('base64')
}

async function start() {
  const { state, saveCreds, bundle } = await useTrackedAuthState(AUTH_FOLDER)

  // fetchLatestBaileysVersion() has a documented bug where it can hang
  // indefinitely on some networks (WhiskeySockets/Baileys#1990) — race it
  // against a timeout so a slow/blocked fetch can never stall pairing.
  let version
  try {
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 5000))
    ])
    version = result.version
  } catch {
    console.log('Skipping the version check (offline or slow) — using the bundled default instead.')
  }

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    printQRInTerminal: false, // must be false — we're using a pairing code, not a QR code
    browser: Browsers.ubuntu('Chrome'),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update

    if (connection === 'connecting' && !sock.authState.creds.registered && !asked) {
      asked = true
      const number = await ask('WhatsApp number for Habibi, digits only with country code (e.g. 2348012345678): ')
      const code = await sock.requestPairingCode(number.trim())
      console.log(`\nPairing code: ${code}`)
      console.log('On the phone: WhatsApp > Linked Devices > Link a Device > Link with phone number instead.\n')
    }

    if (connection === 'open') {
      console.log('\nConnected. Waiting about 45s for the initial sync to settle before exporting...')
      rl.close()
      exportTimer = setTimeout(() => {
        exportTimer = null
        if (exported) return
        exported = true
        const sessionString = buildSessionString(state, bundle)
        console.log('\n==========================================')
        console.log('SESSION_ID — paste this into Railway as an env var:')
        console.log(sessionString)
        console.log('==========================================')
        console.log(`\n${sessionString.length} characters. Treat it like a password — anyone with this string has full control of the bot's WhatsApp account.`)
        console.log('After adding it on Railway and redeploying, Ctrl+C this.')
      }, 45000)
    }

    if (connection === 'close') {
      if (exportTimer) {
        clearTimeout(exportTimer)
        exportTimer = null
      }
      const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : undefined
      const loggedOut = statusCode === DisconnectReason.loggedOut
      console.log('Connection closed.', loggedOut ? 'Logged out — delete the pair_auth folder and re-run to pair again.' : 'Reconnecting...')
      if (!loggedOut) {
        asked = false
        start()
      }
    }
  })
}

start()

process.on('SIGINT', () => {
  try {
    execSync('termux-wake-unlock')
  } catch {}
  console.log('\nWake lock released.')
  process.exit(0)
})
