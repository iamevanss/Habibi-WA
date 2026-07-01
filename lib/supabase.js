import { createClient } from '@supabase/supabase-js'
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys'

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

// ── Session persistence in Supabase ──────────────────────────────────────────

export async function useSupabaseAuthState() {
  const get = async (key) => {
    const { data } = await sb.from('wa_session').select('value').eq('key', key).single()
    return data ? JSON.parse(data.value, BufferJSON.reviver) : null
  }

  const set = async (key, value) => {
    await sb.from('wa_session').upsert({ key, value: JSON.stringify(value, BufferJSON.replacer) })
  }

  const del = async (key) => {
    await sb.from('wa_session').delete().eq('key', key)
  }

  let creds = await get('creds')
  if (!creds) creds = initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(ids.map(async (id) => {
            const val = await get(`${type}-${id}`)
            if (val) {
              if (type === 'app-state-sync-key') {
                data[id] = proto.Message.AppStateSyncKeyData.fromObject(val)
              } else {
                data[id] = val
              }
            }
          }))
          return data
        },
        set: async (data) => {
          await Promise.all(
            Object.entries(data).flatMap(([type, ids]) =>
              Object.entries(ids).map(([id, val]) =>
                val ? set(`${type}-${id}`, val) : del(`${type}-${id}`)
              )
            )
          )
        }
      }
    },
    saveCreds: async () => await set('creds', creds)
  }
}

// ── Group helpers ─────────────────────────────────────────────────────────────

export async function registerGroup(groupId) {
  await sb.from('wa_group').upsert({ group_id: groupId })
}

export async function isGroupRegistered(groupId) {
  const { data } = await sb.from('wa_group').select('group_id').eq('group_id', groupId).single()
  return !!data
}

// ── Member helpers ────────────────────────────────────────────────────────────

export async function getMember(waId, groupId) {
  const { data } = await sb.from('wa_members').select('*').eq('wa_id', waId).eq('group_id', groupId).single()
  return data
}

export async function upsertMember(waId, groupId, username = '') {
  const existing = await getMember(waId, groupId)
  if (!existing) {
    await sb.from('wa_members').insert({ wa_id: waId, group_id: groupId, username, message_count: 0, level: 0, balance: 0 })
  } else if (username && existing.username !== username) {
    await sb.from('wa_members').update({ username }).eq('wa_id', waId).eq('group_id', groupId)
  }
}

export async function incrementMessages(waId, groupId) {
  const member = await getMember(waId, groupId)
  if (!member) return null
  const newCount = (member.message_count || 0) + 1
  const newLevel = Math.floor(newCount / 1000)
  const leveledUp = newLevel > (member.level || 0)
  const newBalance = leveledUp ? (member.balance || 0) + 10000 : (member.balance || 0)
  await sb.from('wa_members').update({
    message_count: newCount,
    level: newLevel,
    balance: newBalance
  }).eq('wa_id', waId).eq('group_id', groupId)
  return { leveledUp, newLevel, newBalance, newCount }
}

export async function getBalance(waId, groupId) {
  const member = await getMember(waId, groupId)
  return member ? (member.balance || 0) : 0
}

export async function updateBalance(waId, groupId, amount) {
  await sb.from('wa_members')
    .update({ balance: amount })
    .eq('wa_id', waId).eq('group_id', groupId)
}

export async function getTopMembers(groupId, limit = 10) {
  const { data } = await sb.from('wa_members')
    .select('wa_id, username, balance, level')
    .eq('group_id', groupId)
    .order('balance', { ascending: false })
    .limit(limit)
  return data || []
}

// ── Chat history ──────────────────────────────────────────────────────────────

export async function getChatHistory(waId) {
  const { data } = await sb.from('wa_chat_history').select('history').eq('wa_id', waId).single()
  return data ? data.history : []
}

export async function saveChatHistory(waId, history) {
  await sb.from('wa_chat_history').upsert({ wa_id: waId, history })
}
