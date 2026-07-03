import 'dotenv/config'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  Browsers
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import express from 'express'
import pino from 'pino'

import {
  useSupabaseAuthState, registerGroup, isGroupRegistered,
  upsertMember, incrementMessages
} from './lib/supabase.js'
import { getAIReply } from './lib/ai.js'
import { handleBalance, handleTop, handleGive, handleSteal, handleRob } from './lib/economy.js'

const PORT        = process.env.PORT || 3000
const PREFIX_CMD  = '.'
const PREFIX_MSG  = '🦩'
const SIGN        = '₹'
const DIAMOND     = '♦'
const TRIGGER_WORDS = ['habibi', 'habs', 'bibi']

const logger = pino({ level: 'silent' })

// Shared socket reference so the web server can call requestPairingCode
let sock = null
let pairingRequested = false
let reconnectDelay   = 5000
let botLive          = false

function pulseText(ms) {
  return `${PREFIX_MSG}\n\n${DIAMOND}\nH a b i b i ' s  P u l s e :  ${ms}  m s\n${DIAMOND}`
}

// ── Pairing web server ────────────────────────────────────────────────────────
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Habibi 🦩 Pairing</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body {
      min-height: 100vh;
      background: #0a0a0a;
      color: #fff;
      font-family: 'Segoe UI', sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #111;
      border: 1px solid #222;
      border-radius: 16px;
      padding: 40px;
      max-width: 420px;
      width: 100%;
      text-align: center;
    }
    .emoji { font-size: 48px; margin-bottom: 12px }
    h1 { font-size: 24px; margin-bottom: 6px }
    p { color: #888; font-size: 14px; margin-bottom: 28px; line-height: 1.6 }
    input {
      width: 100%;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 10px;
      color: #fff;
      font-size: 16px;
      padding: 14px 16px;
      margin-bottom: 14px;
      outline: none;
    }
    input:focus { border-color: #555 }
    button {
      width: 100%;
      background: #fff;
      color: #000;
      border: none;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 600;
      padding: 14px;
      cursor: pointer;
    }
    button:hover { background: #e0e0e0 }
    .code-box {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 10px;
      padding: 20px;
      margin-top: 20px;
      display: none;
    }
    .code {
      font-size: 32px;
      font-weight: 700;
      letter-spacing: 6px;
      color: #fff;
      margin: 10px 0;
    }
    .code-hint { color: #888; font-size: 13px; line-height: 1.6 }
    .error { color: #ff6b6b; margin-top: 12px; font-size: 14px; display: none }
    .status { color: #4caf50; margin-top: 12px; font-size: 14px }
  </style>
</head>
<body>
  <div class="card">
    <div class="emoji">🦩</div>
    <h1>Habibi Pairing</h1>
    <p>Enter your WhatsApp number to generate a pairing code. Then enter the code in WhatsApp → Linked Devices → Link with phone number.</p>
    <input type="tel" id="phone" placeholder="e.g. 2348012345678" />
    <button onclick="pair()">Get Pairing Code</button>
    <div class="error" id="err"></div>
    <div class="code-box" id="codeBox">
      <div class="code-hint">Your pairing code:</div>
      <div class="code" id="code"></div>
      <div class="code-hint">
        Open WhatsApp → Settings → Linked Devices<br>
        → Link a Device → Link with phone number<br>
        → Enter the code above
      </div>
    </div>
  </div>
  <script>
    async function pair() {
      const phone = document.getElementById('phone').value.trim().replace(/\\D/g, '')
      const err   = document.getElementById('err')
      const box   = document.getElementById('codeBox')
      const code  = document.getElementById('code')
      err.style.display = 'none'
      box.style.display = 'none'
      if (!phone) { err.textContent = 'Enter your phone number'; err.style.display = 'block'; return }
      const btn = document.querySelector('button')
      btn.textContent = 'Requesting...'
      btn.disabled = true
      try {
        const res  = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
        const data = await res.json()
        if (data.code) {
          code.textContent = data.code
          box.style.display = 'block'
          btn.textContent = 'Code generated ✅'
        } else {
          err.textContent = data.error || 'Something went wrong'
          err.style.display = 'block'
          btn.textContent = 'Get Pairing Code'
          btn.disabled = false
        }
      } catch (e) {
        err.textContent = 'Request failed — try again'
        err.style.display = 'block'
        btn.textContent = 'Get Pairing Code'
        btn.disabled = false
      }
    }
  </script>
</body>
</html>`)
})

app.get('/status', (req, res) => {
  res.json({ live: botLive, connected: sock?.user ? true : false })
})

app.post('/pair', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g, '')
  if (!phone) return res.json({ error: 'Phone number required' })
  if (!sock)  return res.json({ error: 'Bot socket not ready — try again in a few seconds' })
  if (botLive) return res.json({ error: 'Already connected — no pairing needed' })

  try {
    const code = await sock.requestPairingCode(phone)
    pairingRequested = true
    return res.json({ code })
  } catch (e) {
    return res.json({ error: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`🦩 Pairing server running on port ${PORT}`)
})

// ── WhatsApp connection ───────────────────────────────────────────────────────
async function connectToWhatsApp() {
  const { state, saveCreds } = await useSupabaseAuthState()
  const { version }          = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 60000,
  })

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (connection === 'connecting') {
      console.log('🦩 Connecting to WhatsApp...')
    }

    // Auto-pair if PHONE_NUMBER is set and qr event fires
    if (qr && !state.creds.registered && !pairingRequested && process.env.PHONE_NUMBER) {
      pairingRequested = true
      try {
        const code = await sock.requestPairingCode(process.env.PHONE_NUMBER)
        console.log(`\n==========================================`)
        console.log(`  HABIBI PAIRING CODE: ${code}`)
        console.log(`  WhatsApp > Settings > Linked Devices`)
        console.log(`  > Link a Device > Link with phone number`)
        console.log(`==========================================\n`)
      } catch (e) {
        console.error('Auto-pair error:', e.message)
        console.log('🦩 Visit your Railway URL to pair manually instead')
        pairingRequested = false
      }
    }

    if (qr && !state.creds.registered && !process.env.PHONE_NUMBER) {
      console.log('🦩 Not paired yet — visit your Railway URL to pair')
    }

    if (connection === 'open') {
      botLive = true
      reconnectDelay = 5000
      console.log(`${PREFIX_MSG} Habibi is LIVE on WhatsApp 💕`)
    }

    if (connection === 'close') {
      botLive = false
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`Connection closed — reason: ${reason}`)

      const delay = reconnectDelay
      reconnectDelay = Math.min(reconnectDelay * 2, 60000)

      if (reason === DisconnectReason.loggedOut || reason === 401) {
        console.log('Session invalid — clearing and restarting fresh...')
        const { createClient } = await import('@supabase/supabase-js')
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
        await sb.from('wa_session').delete().neq('key', 'KEEPALL')
        pairingRequested = false
        console.log(`Session cleared. Reconnecting in ${delay / 1000}s...`)
        setTimeout(connectToWhatsApp, delay)
      } else {
        pairingRequested = false
        console.log(`Reconnecting in ${delay / 1000}s...`)
        setTimeout(connectToWhatsApp, delay)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ── Messages ─────────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const isGroup  = msg.key.remoteJid?.endsWith('@g.us')
      const groupId  = isGroup ? msg.key.remoteJid : null
      const senderId = isGroup ? msg.key.participant : msg.key.remoteJid
      if (!senderId) continue
      const waId    = jidNormalizedUser(senderId)
      const replyTo = isGroup ? groupId : msg.key.remoteJid

      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ''
      ).trim()

      if (!text) continue

      const pushName = msg.pushName || waId.split('@')[0]

      if (isGroup) {
        const registered = await isGroupRegistered(groupId)
        if (!registered && !text.startsWith(`${PREFIX_CMD}start`)) continue
        await upsertMember(waId, groupId, pushName)

        if (registered && !text.startsWith(PREFIX_CMD)) {
          const result = await incrementMessages(waId, groupId)
          if (result?.leveledUp) {
            await sock.sendMessage(groupId, {
              text: (
                `${PREFIX_MSG}\n\n${DIAMOND} Level Up! ${DIAMOND}\n\n` +
                `@${pushName} just hit *Level ${result.newLevel}* 🎉\n` +
                `${SIGN}10,000 BibzDollar added!\n` +
                `New balance: ${SIGN}${result.newBalance.toLocaleString()}`
              ),
              mentions: [waId]
            })
          }
        }
      }

      if (text.startsWith(PREFIX_CMD)) {
        const parts = text.slice(1).trim().split(/\s+/)
        const cmd   = parts[0].toLowerCase()
        const args  = parts.slice(1)

        if (cmd === 'start') {
          if (!isGroup) { await sock.sendMessage(replyTo, { text: `${PREFIX_MSG} Group only, darling 💅` }); continue }
          await registerGroup(groupId)
          await upsertMember(waId, groupId, pushName)
          await sock.sendMessage(groupId, {
            text: `${PREFIX_MSG}\n\n${DIAMOND} Habibi is here! ${DIAMOND}\n\nHey everyone 💕 I'm Habibi — your group's new favourite girl.\nType *.help* to see what I can do ✨`
          })
          continue
        }

        if (isGroup && !(await isGroupRegistered(groupId))) continue

        if (cmd === 'help') {
          await sock.sendMessage(replyTo, {
            text: (
              `${PREFIX_MSG}\n\n${DIAMOND} *Habibi's Commands* ${DIAMOND}\n\n` +
              `*.start* — register the group\n*.help* — this menu\n*.pulse* — check my speed\n*.ship @user* — compatibility\n\n` +
              `${DIAMOND} *BibzDollar Economy*\n` +
              `*.balance* — check your ${SIGN}\n*.top* — top 10 richest\n` +
              `*.give <amount> @user* — send ${SIGN}\n*.steal <amount> @user* — 50/50\n*.rob @user* — 40%, all or nothing\n\n` +
              `_Earn ${SIGN}10,000 every 1,000 messages 💬_`
            )
          })
          continue
        }

        if (cmd === 'pulse') {
          const start   = Date.now()
          const sent    = await sock.sendMessage(replyTo, { text: '...' })
          const latency = Date.now() - start
          await sock.sendMessage(replyTo, { text: pulseText(latency), edit: sent.key })
          continue
        }

        if (cmd === 'ship') {
          const mentioned  = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
          const partnerJid = mentioned[0] ? jidNormalizedUser(mentioned[0]) : null
          const partnerName = partnerJid ? partnerJid.split('@')[0] : args[0]?.replace('@', '')
          if (!partnerName) { await sock.sendMessage(replyTo, { text: `${PREFIX_MSG} Tag someone to ship 💕` }); continue }
          const score      = Math.floor(Math.random() * 90) + 10
          const bar        = '💗'.repeat(Math.round(score / 10)) + '🤍'.repeat(10 - Math.round(score / 10))
          const verdict    = score >= 80 ? 'SOULMATES 😍' : score >= 60 ? "There's something there 💕" : score >= 40 ? 'Complicated 😅' : 'Maybe friends? 💀'
          await sock.sendMessage(replyTo, {
            text: `${PREFIX_MSG}\n\n${DIAMOND} *Ship Report* ${DIAMOND}\n\n*${pushName}* × *${partnerName}*\n${bar}\n*${score}% compatible*\n\n${verdict}`,
            mentions: partnerJid ? [partnerJid] : []
          })
          continue
        }

        if (cmd === 'balance') {
          if (!isGroup) continue
          await sock.sendMessage(groupId, { text: await handleBalance(waId, groupId, pushName) })
          continue
        }

        if (cmd === 'top') {
          if (!isGroup) continue
          await sock.sendMessage(groupId, { text: await handleTop(groupId) })
          continue
        }

        if (cmd === 'give') {
          if (!isGroup) continue
          const amount    = parseInt(args[0])
          const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
          const targetJid = mentioned[0] ? jidNormalizedUser(mentioned[0]) : null
          if (!targetJid || isNaN(amount)) { await sock.sendMessage(groupId, { text: `${PREFIX_MSG} Usage: .give <amount> @user 💸` }); continue }
          const targetName = targetJid.split('@')[0]
          await upsertMember(targetJid, groupId, targetName)
          await sock.sendMessage(groupId, { text: await handleGive(waId, groupId, targetJid, targetName, amount), mentions: [targetJid] })
          continue
        }

        if (cmd === 'steal') {
          if (!isGroup) continue
          const amount    = parseInt(args[0])
          const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
          const targetJid = mentioned[0] ? jidNormalizedUser(mentioned[0]) : null
          if (!targetJid || isNaN(amount)) { await sock.sendMessage(groupId, { text: `${PREFIX_MSG} Usage: .steal <amount> @user 😈` }); continue }
          const targetName = targetJid.split('@')[0]
          await upsertMember(targetJid, groupId, targetName)
          await sock.sendMessage(groupId, { text: await handleSteal(waId, groupId, targetJid, targetName, amount), mentions: [targetJid] })
          continue
        }

        if (cmd === 'rob') {
          if (!isGroup) continue
          const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
          const targetJid = mentioned[0] ? jidNormalizedUser(mentioned[0]) : null
          if (!targetJid) { await sock.sendMessage(groupId, { text: `${PREFIX_MSG} Tag someone to rob 😈` }); continue }
          const targetName = targetJid.split('@')[0]
          await upsertMember(targetJid, groupId, targetName)
          await sock.sendMessage(groupId, { text: await handleRob(waId, groupId, targetJid, targetName), mentions: [targetJid] })
          continue
        }

        continue
      }

      // ── Trigger word / AI reply ─────────────────────────────────────────
      if (isGroup && !(await isGroupRegistered(groupId))) continue

      const lower       = text.toLowerCase()
      const isMentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.some(
        jid => jidNormalizedUser(jid) === jidNormalizedUser(sock.user?.id || '')
      )
      const hasTrigger = TRIGGER_WORDS.some(w => lower.includes(w))

      if (isMentioned || hasTrigger || !isGroup) {
        try {
          const reply = await getAIReply(waId, text)
          await sock.sendMessage(replyTo, { text: reply, mentions: isGroup ? [waId] : [] })
        } catch (e) {
          console.error('AI error:', e.message)
        }
      }
    }
  })
}

connectToWhatsApp()
