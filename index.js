import 'dotenv/config'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { Boom } from '@hapi/boom'

import { useSupabaseAuthState, registerGroup, isGroupRegistered, upsertMember, incrementMessages } from './lib/supabase.js'
import { getAIReply } from './lib/ai.js'
import { spacedText, handleBalance, handleTop, handleGive, handleSteal, handleRob } from './lib/economy.js'

const PREFIX_CMD  = '.'
const PREFIX_MSG  = '🦩'
const SIGN        = '₹'
const DIAMOND     = '♦'
const TRIGGER_WORDS = ['habibi', 'habs', 'bibi']
const PHONE       = process.env.PHONE_NUMBER // e.g. 2348012345678

const logger = pino({ level: 'silent' })

// Spaced pulse text
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
    browser: ['Habibi', 'Chrome', '120.0.0']
  })

  // ── Pairing code ─────────────────────────────────────────────────────────
  if (!state.creds.registered) {
    const code = await sock.requestPairingCode(PHONE)
    console.log(`\n==========================================`)
    console.log(`  HABIBI PAIRING CODE: ${code}`)
    console.log(`  Enter this in WhatsApp:`)
    console.log(`  Settings > Linked Devices > Link a Device`)
    console.log(`==========================================\n`)
  }

  // ── Connection updates ────────────────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`Connection closed: ${reason}`)
      if (reason !== DisconnectReason.loggedOut) {
        console.log('Reconnecting...')
        connectToWhatsApp()
      } else {
        console.log('Logged out. Clear session in Supabase and restart.')
      }
    } else if (connection === 'open') {
      console.log(`${PREFIX_MSG} Habibi is live on WhatsApp 💕`)
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ── Messages ──────────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const isGroup  = msg.key.remoteJid.endsWith('@g.us')
      const groupId  = isGroup ? msg.key.remoteJid : null
      const senderId = isGroup ? msg.key.participant : msg.key.remoteJid
      const waId     = jidNormalizedUser(senderId)

      // Extract text
      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ''
      ).trim()

      if (!text) continue

      // Sender name
      const pushName = msg.pushName || waId.split('@')[0]

      // Only handle group messages from registered group
      if (isGroup) {
        const registered = await isGroupRegistered(groupId)

        // Allow .start even before registration
        if (!registered && !text.startsWith(`${PREFIX_CMD}start`)) continue

        // Track member
        await upsertMember(waId, groupId, pushName)

        // Count message + level up check
        if (registered && !text.startsWith(PREFIX_CMD)) {
          const result = await incrementMessages(waId, groupId)
          if (result?.leveledUp) {
            await sock.sendMessage(groupId, {
              text: (
                `${PREFIX_MSG}\n\n` +
                `${DIAMOND} Level Up! ${DIAMOND}\n\n` +
                `@${pushName} just hit *Level ${result.newLevel}* 🎉\n` +
                `${SIGN}10,000 BibzDollar added to your balance 💰\n` +
                `New balance: ${SIGN}${result.newBalance.toLocaleString()}`
              ),
              mentions: [waId]
            })
          }
        }
      }

      // ── Command handling ──────────────────────────────────────────────────
      if (text.startsWith(PREFIX_CMD)) {
        const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/)
        const cmd = rawCmd.toLowerCase()

        // .start
        if (cmd === 'start') {
          if (!isGroup) {
            await sock.sendMessage(msg.key.remoteJid, {
              text: `${PREFIX_MSG} This command only works in a group, darling 💅`
            })
            continue
          }
          await registerGroup(groupId)
          await upsertMember(waId, groupId, pushName)
          await sock.sendMessage(groupId, {
            text: (
              `${PREFIX_MSG}\n\n` +
              `${DIAMOND} Habibi is here! ${DIAMOND}\n\n` +
              `Hey everyone 💕 I'm Habibi — your group's new favorite girl.\n` +
              `Talk to me, play with BibzDollar, and vibe.\n\n` +
              `Type *.help* to see what I can do~ ✨`
            )
          })
          continue
        }

        // Block all commands if group not registered
        if (isGroup && !(await isGroupRegistered(groupId))) continue

        // .help
        if (cmd === 'help') {
          await sock.sendMessage(isGroup ? groupId : msg.key.remoteJid, {
            text: (
              `${PREFIX_MSG}\n\n` +
              `${DIAMOND} *Habibi's Commands* ${DIAMOND}\n\n` +
              `*.start* — register the group\n` +
              `*.help* — this menu\n` +
              `*.pulse* — check my speed\n` +
              `*.ship* — check your compatibility\n\n` +
              `${DIAMOND} *BibzDollar Economy*\n` +
              `*.balance* — check your ${SIGN}\n` +
              `*.top* — top 10 richest\n` +
              `*.give <amount> @user* — send ${SIGN}\n` +
              `*.steal <amount> @user* — try to steal ${SIGN}\n` +
              `*.rob @user* — try to take everything\n\n` +
              `_Earn ${SIGN}10,000 every 1,000 messages — keep chatting 💬_`
            )
          })
          continue
        }

        // .pulse
        if (cmd === 'pulse') {
          const start   = Date.now()
          const sent    = await sock.sendMessage(isGroup ? groupId : msg.key.remoteJid, { text: '...' })
          const latency = Date.now() - start
          await sock.sendMessage(isGroup ? groupId : msg.key.remoteJid, {
            text: pulseText(latency),
            edit: sent.key
          })
          continue
        }

        // .ship
        if (cmd === 'ship') {
          const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
          const partner   = mentioned[0] ? jidNormalizedUser(mentioned[0]) : null
          const partnerName = partner ? partner.split('@')[0] : args[0]?.replace('@', '')

          if (!partnerName) {
            await sock.sendMessage(isGroup ? groupId : msg.key.remoteJid, {
              text: `${PREFIX_MSG} Tag someone to ship with, love 💕 e.g. .ship @user`
            })
            continue
          }

          const score      = Math.floor(Math.random() * 90) + 10
          const bar_filled = Math.round(score / 10)
          const bar        = '💗'.repeat(bar_filled) + '🤍'.repeat(10 - bar_filled)

          let verdict
          if (score >= 80)      verdict = 'SOULMATES omg 😍 The universe said yes'
          else if (score >= 60) verdict = 'There\'s something there... 💕'
          else if (score >= 40) verdict = 'Complicated but make it cute 😅'
          else                  verdict = 'Maybe just be friends? 💀'

          await sock.sendMessage(isGroup ? groupId : msg.key.remoteJid, {
            text: (
              `${PREFIX_MSG}\n\n` +
              `${DIAMOND} *Ship Report* ${DIAMOND}\n\n` +
              `*${pushName}* × *${partnerName}*\n` +
              `${bar}\n` +
              `*${score}% compatible*\n\n` +
              `${verdict}`
            ),
            mentions: partner ? [partner] : []
          })
          continue
        }

        // .balance
        if (cmd === 'balance') {
          if (!isGroup) continue
          const reply = await handleBalance(waId, groupId, pushName)
          await sock.sendMessage(groupId, { text: reply })
          continue
        }

        // .top
        if (cmd === 'top') {
          if (!isGroup) continue
          const reply = await handleTop(groupId)
          await sock.sendMessage(groupId, { text: reply })
          continue
        }

        // .give <amount> @user
        if (cmd === 'give') {
          if (!isGroup) continue
          const amount    = parseInt(args[0])
          const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
          const targetJid = mentioned[0] ? jidNormalizedUser(mentioned[0]) : null

          if (!targetJid || isNaN(amount)) {
            await sock.sendMessage(groupId, {
              text: `${PREFIX_MSG} Usage: .give <amount> @user 💸`
            })
            continue
          }
          const targetName = targetJid.split('@')[0]
          await upsertMember(targetJid, groupId, targetName)
          const reply = await handleGive(waId, groupId, targetJid, targetName, amount)
          await sock.sendMessage(groupId, { text: reply, mentions: [targetJid] })
          continue
        }

        // .steal <amount> @user
        if (cmd === 'steal') {
          if (!isGroup) continue
          const amount    = parseInt(args[0])
          const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
          const targetJid = mentioned[0] ? jidNormalizedUser(mentioned[0]) : null

          if (!targetJid || isNaN(amount)) {
            await sock.sendMessage(groupId, {
              text: `${PREFIX_MSG} Usage: .steal <amount> @user 😈`
            })
            continue
          }
          const targetName = targetJid.split('@')[0]
          await upsertMember(targetJid, groupId, targetName)
          const reply = await handleSteal(waId, groupId, targetJid, targetName, amount)
          await sock.sendMessage(groupId, { text: reply, mentions: [targetJid] })
          continue
        }

        // .rob @user
        if (cmd === 'rob') {
          if (!isGroup) continue
          const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
          const targetJid = mentioned[0] ? jidNormalizedUser(mentioned[0]) : null

          if (!targetJid) {
            await sock.sendMessage(groupId, {
              text: `${PREFIX_MSG} Tag someone to rob, babe 😈 e.g. .rob @user`
            })
            continue
          }
          const targetName = targetJid.split('@')[0]
          await upsertMember(targetJid, groupId, targetName)
          const reply = await handleRob(waId, groupId, targetJid, targetName)
          await sock.sendMessage(groupId, { text: reply, mentions: [targetJid] })
          continue
        }
      }

      // ── Trigger word / AI reply ─────────────────────────────────────────
      if (isGroup && !(await isGroupRegistered(groupId))) continue

      const lower         = text.toLowerCase()
      const isMentioned   = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.some(
        jid => jidNormalizedUser(jid) === jidNormalizedUser(sock.user.id)
      )
      const isReply       = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
      const hasTrigger    = TRIGGER_WORDS.some(w => lower.includes(w))

      if (!isGroup || isMentioned || hasTrigger) {
        const reply = await getAIReply(waId, text)
        await sock.sendMessage(isGroup ? groupId : msg.key.remoteJid, {
          text: reply,
          ...(isGroup && { mentions: [waId] })
        })
      }
    }
  })
}

connectToWhatsApp()
