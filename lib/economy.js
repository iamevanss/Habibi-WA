import {
  getMember, getBalance, updateBalance, getTopMembers
} from './supabase.js'

const PREFIX  = '🦩'
const SIGN    = '₹'
const DIAMOND = '♦'

// Spaced font converter
export function spacedText(text) {
  return text.split('').join(' ')
}

// ── .balance ──────────────────────────────────────────────────────────────────
export async function handleBalance(waId, groupId, username) {
  const member = await getMember(waId, groupId)
  if (!member) return `${PREFIX} You haven't been registered yet babe — send a message first!`
  const bal   = member.balance || 0
  const level = member.level  || 0
  return (
    `${PREFIX}\n\n` +
    `${DIAMOND} *${username || 'You'}*\n` +
    `${SIGN} Balance: *${bal.toLocaleString()}*\n` +
    `${DIAMOND} Level: *${level}*\n` +
    `${DIAMOND} Messages: *${member.message_count || 0}*`
  )
}

// ── .top ──────────────────────────────────────────────────────────────────────
export async function handleTop(groupId) {
  const top = await getTopMembers(groupId, 10)
  if (!top.length) return `${PREFIX} No one's made any money yet babe 😅 Start chatting!`

  const medals = ['🥇', '🥈', '🥉']
  const lines  = top.map((m, i) => {
    const medal  = medals[i] || `${i + 1}.`
    const name   = m.username || m.wa_id.split('@')[0]
    const bal    = (m.balance || 0).toLocaleString()
    return `${medal} @${name} — ${SIGN}${bal}`
  })

  return `${PREFIX}\n\n${DIAMOND} *Top 10 Richest* ${DIAMOND}\n\n${lines.join('\n')}`
}

// ── .give ─────────────────────────────────────────────────────────────────────
export async function handleGive(senderId, groupId, targetId, targetName, amount) {
  if (isNaN(amount) || amount <= 0) return `${PREFIX} Enter a valid amount babe 💀`
  amount = Math.floor(amount)

  const senderBal = await getBalance(senderId, groupId)
  if (senderBal < amount) {
    return `${PREFIX} You're broke babe 😭 You only have ${SIGN}${senderBal.toLocaleString()}`
  }

  await updateBalance(senderId, groupId, senderBal - amount)
  const targetBal = await getBalance(targetId, groupId)
  await updateBalance(targetId, groupId, targetBal + amount)

  return (
    `${PREFIX}\n\n` +
    `${DIAMOND} Transfer Successful\n\n` +
    `Sent ${SIGN}${amount.toLocaleString()} to @${targetName} 💸\n` +
    `Your new balance: ${SIGN}${(senderBal - amount).toLocaleString()}`
  )
}

// ── .steal ────────────────────────────────────────────────────────────────────
export async function handleSteal(senderId, groupId, targetId, targetName, amount) {
  if (isNaN(amount) || amount <= 0) return `${PREFIX} Enter a valid amount babe 💀`
  amount = Math.floor(amount)

  const targetBal = await getBalance(targetId, groupId)
  if (targetBal < amount) {
    return `${PREFIX} @${targetName} doesn't even have that much 💀 They're broker than you`
  }

  // 50% chance of success
  const success = Math.random() < 0.5

  if (success) {
    const senderBal = await getBalance(senderId, groupId)
    await updateBalance(senderId, groupId, senderBal + amount)
    await updateBalance(targetId, groupId, targetBal - amount)
    return (
      `${PREFIX}\n\n` +
      `${DIAMOND} Steal Successful 😈\n\n` +
      `You swiped ${SIGN}${amount.toLocaleString()} from @${targetName}\n` +
      `And they have no clue 💅`
    )
  } else {
    // The stolen amount just vanishes — nobody gets it
    return (
      `${PREFIX}\n\n` +
      `${DIAMOND} Steal Failed 💀\n\n` +
      `You got caught trying to steal from @${targetName}\n` +
      `${SIGN}${amount.toLocaleString()} vanished into thin air 😭 That's your loss`
    )
  }
}

// ── .rob ──────────────────────────────────────────────────────────────────────
export async function handleRob(senderId, groupId, targetId, targetName) {
  const targetBal = await getBalance(targetId, groupId)
  if (targetBal <= 0) {
    return `${PREFIX} @${targetName} is absolutely broke babe 💀 Nothing to rob`
  }

  // 40% chance of success
  const success = Math.random() < 0.4

  if (success) {
    const senderBal = await getBalance(senderId, groupId)
    await updateBalance(senderId, groupId, senderBal + targetBal)
    await updateBalance(targetId, groupId, 0)
    return (
      `${PREFIX}\n\n` +
      `${DIAMOND} ROB SUCCESSFUL 😈👑\n\n` +
      `You robbed @${targetName} of EVERYTHING\n` +
      `${SIGN}${targetBal.toLocaleString()} added to your balance 💰\n` +
      `They're on the streets now 💀`
    )
  } else {
    // Sender loses ALL to target
    const senderBal = await getBalance(senderId, groupId)
    if (senderBal <= 0) {
      return `${PREFIX} You're broke AND a failed robber 💀 You had nothing to lose tho`
    }
    await updateBalance(targetId, groupId, targetBal + senderBal)
    await updateBalance(senderId, groupId, 0)
    return (
      `${PREFIX}\n\n` +
      `${DIAMOND} ROB FAILED 💀\n\n` +
      `@${targetName} caught you red-handed\n` +
      `They took ALL your ${SIGN}${senderBal.toLocaleString()}\n` +
      `You're on the streets now 😭`
    )
  }
}
