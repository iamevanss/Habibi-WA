import 'dotenv/config'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  Browsers
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { Boom } from '@hapi/boom'

import {
  useSupabaseAuthState, registerGroup, isGroupRegistered,
  upsertMember, incrementMessages
} from './lib/supabase.js'
import { getAIReply } from './lib/ai.js'
import { handleBalance, handleTop, handleGive, handleSteal, handleRob } from './lib/economy.js'

const PREFIX_CMD    = '.'
const PREFIX_MSG    = '🦩'
const SIGN          = '₹'
const DIAMOND       = '♦'
const TRIGGER_WORDS = ['habibi', 'habs', 'bibi']
const PHONE         = process.env.PHONE_NUMBER

const logger = pino({ level: 'silent' })

let pairingRequested = false
let reconnectDelay = 5000

function pulseText(ms) {
  const label = `H a b i b i ' s  P u l s e :  ${ms}  m s`
  return `${PREFIX_MSG}\n\n${DIAMOND}\n${label}\n${DIAMOND}`
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useSupabaseAuthState()
  const { version }          = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 2000
  })

  // ── Connection updates ────────────────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (connection === 'connecting') {
      console.log('🦩 Connecting to WhatsApp...')
    }

    // Request the pairing code while the socket is still connecting — 'open'
    // only ever fires AFTER a session is authenticated, so a fresh/unregistered
    // bot never reaches 'open' on its own. Gating the request behind 'open'
    // (as this used to) meant it could never actually fire for a new login.
    if ((connection === 'connecting' || qr) && !state.creds.registered && !pairingRequested) {
      pairingRequested = true

      if (!PHONE) {
        console.error('⚠️  No saved session (SESSION_ID) and no PHONE_NUMBER set — cannot pair. Set one of the two.')
      } else {
        try {
          console.log('🦩 No saved session — requesting pairing code from WhatsApp...')
          const code = await sock.requestPairingCode(PHONE)
          console.log(`\n==========================================`)
          console.log(`  HABIBI PAIRING CODE: ${code}`)
          console.log(`  WhatsApp > Settings > Linked Devices`)
          console.log(`  > Link a Device > Link with phone number`)
          console.log(`==========================================\n`)
        } catch (e) {
          console.error('Pairing code error:', e.message)
          console.error('⚠️  If this is a timeout, 401, or 429 ("rate-overlimit"), that\'s WhatsApp')
          console.error('    rate-limiting/blocking Railway\'s datacenter IP — not a bug in the bot.')
          console.error('    Generate a session elsewhere and set it as SESSION_ID instead (see README).')
          pairingRequested = false
        }
      }
    }

    if (connection === 'open') {
      console.log(`${PREFIX_MSG} Habibi is LIVE on WhatsApp 💕`)
      reconnectDelay = 5000
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`Connection closed — reason: ${reason}`)

      const delay = reconnectDelay
      reconnectDelay = Math.min(reconnectDelay * 2, 60000)

      if (reason === DisconnectReason.loggedOut || reason === 401) {
        console.log('Session invalid — clearing and restarting fresh...')
        // Auto-clear stale session keys from Supabase
        const { createClient } = await import('@supabase/supabase-js')
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
        await sb.from('wa_session').delete().neq('key', 'KEEPALL')
        pairingRequested = false
        console.log(`Session cleared. Reconnecting in ${delay / 1000}s...`)
        setTimeout(connectToWhatsApp, delay)
      } else {
        console.log(`Reconnecting in ${delay / 1000}s...`)
        pairingRequested = false
        setTimeout(connectToWhatsApp, delay)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ── Messages ──────────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const isGroup  = msg.key.remoteJid?.endsWith('@g.us')
      const groupId  = isGroup ? msg.key.remoteJid : null
      const senderId = isGroup ? msg.key.participant : msg.key.remoteJid
      if (!senderId) continue
      const waId     = jidNormalizedUser(senderId)
      const replyTo  = isGroup ? groupId : msg.key.remoteJid

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
                `${PREFIX_MSG}\n\n` +
                `${DIAMOND} Level Up! ${DIAMOND}\n\n` +
                `@${pushName} just hit *Level ${result.newLevel}* 🎉\n` +
                `${SIGN}10,000 BibzDollar added!\n` +
                `New balance: ${SIGN}${result.newBalance.toLocaleString()}`
              ),
              mentions: [waId]
            })
          }
        }
      }

      // ── Commands ──────────────────────────────────────────────────────────
      if (text.startsWith(PREFIX_CMD)) {
        const parts  = text.slice(1).trim().split(/\s+/)
        const cmd    = parts[0].toLowerCase()
        const args   = parts.slice(1)

        if (cmd === 'start') {
          if (!isGroup) {
            await sock.sendMessage(replyTo, { text: `${PREFIX_MSG} This only works in a group, darling 💅` })
            continue
          }
          await registerGroup(groupId)
          await upsertMember(waId, groupId, pushName)
          await sock.sendMessage(groupId, {
            text: (
              `${PREFIX_MSG}\n\n` +
              `${DIAMOND} Habibi is here! ${DIAMOND}\n\n` +
              `Hey everyone 💕 I'm Habibi — your group's new favourite girl.\n` +
              `Talk to me, play with BibzDollar, and vibe.\n\n` +
              `Type *.help* to see what I can do ✨`
            )
          })
          continue
        }

        if (isGroup && !(await isGroupRegistered(groupId))) continue

        if (cmd === 'help') {
          await sock.sendMessage(replyTo, {
            text: (
              `${PREFIX_MSG}\n\n` +
              `${DIAMOND} *Habibi's Commands* ${DIAMOND}\n\n` +
              `*.start* — register the group\n` +
              `*.help* — this menu\n` +
              `*.pulse* — check my speed\n` +
              `*.ship @user* — compatibility check\n\n` +
              `${DIAMOND} *BibzDollar Economy*\n` +
              `*.balance* — check your ${SIGN}\n` +
              `*.top* — top 10 richest\n` +
              `*.give <amount> @user* — send ${SIGN}\n` +
              `*.steal <amount> @user* — 50/50 chance\n` +
              `*.rob @user* — 40% chance, all or nothing\n\n` +
              `_Earn ${SIGN}10,000 every 1,000 messages 💬_`
            )
          })
          continue
        }

        if (cmd === 'pulse') {
          const start   = Date.now()
          const sent    = await sock.sendMessage(replyTo, { text: '...' })
          const latency = Date.now() - start
          await sock.sendMessage(replyTo, {
            text: pulseText(latency),
            edit: sent.key
          })
          continue
        }

        if (cmd === 'ship') {
          const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
          const partnerJid = mentioned[0] ? jidNormalizedUser(mentioned[0]) : null
          const partnerName = partnerJid ? partnerJid.split('@')[0] : args[0]?.replace('@', '')

          if (!partnerName) {
            await sock.sendMessage(replyTo, { text: `${PREFIX_MSG} Tag someone to ship with 💕 e.g. .ship @user` })
            continue
          }

          const score       = Math.floor(Math.random() * 90) + 10
          const bar_filled  = Math.round(score / 10)
          const bar         = '💗'.repeat(bar_filled) + '🤍'.repeat(10 - bar_filled)
          let verdict
          if (score >= 80)      verdict = 'SOULMATES omg 😍 The universe said yes'
          else if (score >= 60) verdict = "There's something there... 💕"
          else if (score >= 40) verdict = 'Complicated but make it cute 😅'
          else                  verdict = 'Maybe just be friends? 💀'

          await sock.sendMessage(replyTo, {
            text: (
              `${PREFIX_MSG}\n\n` +
              `${DIAMOND} *Ship Report* ${DIAMOND}\n\n` +
              `*${pushName}* × *${partnerName}*\n` +
              `${bar}\n` +
              `*${score}% compatible*\n\n` +
              `${verdict}`
            ),
            mentions: partnerJid ? [partnerJid] : []
          })
          continue
        }

        if (cmd === 'balance') {
          if (!isGroup) continue
          const reply = await handleBalance(waId, groupId, pushName)
          await sock.sendMessage(groupId, { text: reply })
          continue
        }

        if (cmd === 'top') {
          if (!isGroup) continue
          const reply = await handleTop(groupId)
          await sock.sendMessage(groupId, { text: reply })
          continue
        }

        if (cmd === 'give') {
          if (!isGroup) continue
          const amount     = parseInt(args[0])
          const mentioned  = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
          const targetJid  = mentioned[0] ? jidNormalizedUser(mentioned[0]) : null
          if (!targetJid || isNaN(amount)) {
            await sock.sendMessage(groupId, { text: `${PREFIX_MSG} Usage: .give <amount> @user 💸` })
            continue
          }
          const targetName = targetJid.split('@')[0]
          await upsertMember(targetJid, groupId, targetName)
          const reply = await handleGive(waId, groupId, targetJid, targetName, amount)
          await sock.sendMessage(groupId, { text: reply, mentions: [targetJid] })
          continue
        }

        if (cmd === 'steal') {
          if (!isGroup) continue
          const amount    = parseInt(args[0])
          const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
          const targetJid = mentioned[0] ? jidNormalizedUser(mentioned[0]) : null
          if (!targetJid || isNaN(amount)) {
            await sock.sendMessage(groupId, { text: `${PREFIX_MSG} Usage: .steal <amount> @user 😈` })
            continue
          }
          const targetName = targetJid.split('@')[0]
          await upsertMember(targetJid, groupId, targetName)
          const reply = await handleSteal(waId, groupId, targetJid, targetName, amount)
          await sock.sendMessage(groupId, { text: reply, mentions: [targetJid] })
          continue
        }

        if (cmd === 'rob') {
          if (!isGroup) continue
          const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
          const targetJid = mentioned[0] ? jidNormalizedUser(mentioned[0]) : null
          if (!targetJid) {
            await sock.sendMessage(groupId, { text: `${PREFIX_MSG} Tag someone to rob 😈 e.g. .rob @user` })
            continue
          }
          const targetName = targetJid.split('@')[0]
          await upsertMember(targetJid, groupId, targetName)
          const reply = await handleRob(waId, groupId, targetJid, targetName)
          await sock.sendMessage(groupId, { text: reply, mentions: [targetJid] })
          continue
        }

        continue
      }

      // ── Trigger word / AI reply ───────────────────────────────────────────
      if (isGroup && !(await isGroupRegistered(groupId))) continue

      const lower       = text.toLowerCase()
      const isMentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.some(
        jid => jidNormalizedUser(jid) === jidNormalizedUser(sock.user?.id || '')
      )
      const hasTrigger = TRIGGER_WORDS.some(w => lower.includes(w))

      if (isMentioned || hasTrigger || !isGroup) {
        try {
          const reply = await getAIReply(waId, text)
          await sock.sendMessage(replyTo, {
            text: reply,
            mentions: isGroup ? [waId] : []
          })
        } catch (e) {
          console.error('AI reply error:', e.message)
        }
      }
    }
  })
}

connectToWhatsApp()
