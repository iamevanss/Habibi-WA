# 🦩 Habibi WA

> *she talks. she earns. she steals. she's your group's new main character.*

---

## what is she

Habibi is a WhatsApp group bot built by **Stain** — sassy, sweet, and dangerously fun. She's not your average bot that just answers questions and dies. She builds an economy inside your group, remembers conversations, claps back at jailbreak attempts, and responds to her name like a real one.

She's one group only. No mass deployment. No spam. Just vibes.

---

## what she does

### 💬 personality
Talk to her. Tag her. Call her Habibi, Habs, or Bibi — she responds to all three.  
She runs on Groq's LLaMA model and has a full jailbreak protection system so nobody's breaking her character.

### 💰 bibzdollar economy
Every 1,000 messages = Level Up + ₹10,000 added to your balance.  
The longer your members chat, the richer they get. Then chaos begins.

| command | what it does |
|---|---|
| `.balance` | check your ₹ |
| `.top` | top 10 richest in the group |
| `.give <amount> @user` | transfer ₹ — always succeeds |
| `.steal <amount> @user` | 50/50 chance — fail and the money just disappears |
| `.rob @user` | 40% success — fail and you lose EVERYTHING to them |

### ⚡ other commands
| command | what it does |
|---|---|
| `.start` | registers the group, wakes her up |
| `.help` | command menu |
| `.pulse` | latency check, aesthetic format |
| `.ship @user` | compatibility check, 10-90% score |

---

## stack

- **Runtime** — Node.js 20+
- **WhatsApp** — Baileys (`@whiskeysockets/baileys`)
- **Database** — Supabase (session persistence + economy)
- **AI** — Groq API (`llama-3.3-70b-versatile`)
- **Hosting** — Railway

---

## setup

### 1. clone and install
```bash
git clone https://github.com/iamevanss/Habibi-WA.git
cd habibi-wa
npm install
```

### 2. environment variables
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
GROQ_API_KEY=your-groq-key
PHONE_NUMBER=2348012345678
```
`PHONE_NUMBER` — country code + number, no `+` sign.

### 3. deploy to Railway
- Push to GitHub
- Create new Railway service from the repo
- Add the env vars above
- Deploy — pairing code appears in logs

### 4. pair
```
==========================================
  HABIBI PAIRING CODE: XXXX-XXXX
  Enter this in WhatsApp:
  Settings > Linked Devices > Link a Device
==========================================
```
Session saves to Supabase automatically — no re-pairing on redeploy.

### 5. activate
Add the bot number to your group, then type `.start`

---

## how the economy works

```
chat in group
     ↓
every message tracked per member
     ↓
every 1,000 messages → Level Up → +₹10,000
     ↓
spend it, steal it, lose it all in a rob
     ↓
chaos
```

**steal logic** — 50% chance. On fail, the amount you tried to steal vanishes. Nobody gets it.  
**rob logic** — 40% chance. On fail, you lose your entire balance to the person you tried to rob.  
**give** — always works. no risk, just generosity (or manipulation 👀)

---

## security

Three-layer jailbreak protection:
1. **Hardened system prompt** — identity lock, jailbreak detection patterns, output validation rules
2. **Security injection** — every user message is marked as untrusted before reaching the model
3. **Backend filter** — response is scanned before being sent; unauthorized claims are intercepted and replaced

Creator is Stain. That's hardcoded. Nobody's changing it.

---

## notes

- Built for **one group only** — single group architecture to stay clean and avoid ban risk
- Session is stored in Supabase — Railway restarts don't require re-pairing
- Use a **dedicated SIM** — don't link your main number
- Not affiliated with WhatsApp or Meta in any way

---

*built by Stain — [@heisevanss](https://t.me/heisevanss)*  
*part of Stain Projects*
