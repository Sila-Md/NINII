import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import fsPromises from 'fs/promises'
import { randomUUID } from 'crypto'
import Pino from 'pino'
import QRCode from 'qrcode'
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'

const logger = Pino({ level: 'info' })
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const PORT = process.env.PORT || 3000

// In-memory sessions state for SSE and management
const sessions = new Map()

// track active session by phone number for pairing flows
const activeByPhone = new Map()
// idle timeout (ms) - wipe auth dir & close socket if no activity
const IDLE_TIMEOUT = Number(process.env.IDLE_TIMEOUT_MS || 5 * 60 * 1000)

function startIdleTimer(sessionId) {
  const sess = sessions.get(sessionId)
  if (!sess) return
  // clear existing timer
  if (sess._idleTimer) clearTimeout(sess._idleTimer)
  sess._idleTimer = setTimeout(async () => {
    try {
      const s = sessions.get(sessionId)
      if (!s) return
      const { authDir, socket, sse, phone } = s
      logger.info({ sessionId }, 'session idle timeout, cleaning up')
      // notify client if SSE open
      if (sse) {
        try { sendSSE(sse, 'status', { status: 'idle_timeout' }) } catch(e){}
        try { sendSSE(sse, 'finished', { status: 'timeout_cleanup' }) } catch(e){}
        try { sse.end() } catch(e){}
      }
      // try graceful socket close
      try { if (socket) await socket.logout() } catch(e){}
      try { if (socket && socket.ws) socket.ws.close() } catch(e){}
      // cleanup auth dir
      if (authDir) await cleanupDir(authDir)
      sessions.delete(sessionId)
      if (phone) {
        const mapped = activeByPhone.get(phone)
        if (mapped === sessionId) activeByPhone.delete(phone)
      }
    } catch (e) {
      logger.warn({err:e}, 'idle cleanup error')
    }
  }, IDLE_TIMEOUT)
  sessions.set(sessionId, sess)
}

function clearSession(sessionId) {
  const s = sessions.get(sessionId)
  if (!s) return
  if (s._idleTimer) clearTimeout(s._idleTimer)
  try { if (s.socket) s.socket.ws && s.socket.ws.close() } catch(e){}
  // call logout safely — logout() returns a promise so attaching a catch avoids unhandled rejections
  try {
    if (s.socket && s.socket.logout) {
      const maybePromise = s.socket.logout()
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.catch(() => {})
      }
    }
  } catch(e) {}
  if (s.authDir) cleanupDir(s.authDir).catch(()=>{})
  if (s.phone) {
    const mapped = activeByPhone.get(s.phone)
    if (mapped === sessionId) activeByPhone.delete(s.phone)
  }
  sessions.delete(sessionId)
}

// Helper to finalize a session: wait briefly for creds to be persisted then logout and cleanup
async function finalizeSession(sessionId, reason = 'done') {
  let s = sessions.get(sessionId)
  if (!s) return

  // wait up to 3s for creds to be updated and saved (helps avoid race where we close before keys are stored)
  const start = Date.now()
  const maxWait = 3000
  while (!s.credsSaved && Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 200))
    s = sessions.get(sessionId)
    if (!s) return
  }

  // attempt graceful logout with catches
  try {
    if (s.socket && s.socket.logout) {
      await s.socket.logout().catch(() => {})
    }
  } catch (e) {}

  try { if (s.socket && s.socket.ws) s.socket.ws.close() } catch(e){}
  if (s.authDir) await cleanupDir(s.authDir).catch(()=>{})
  if (s.sse) {
    try { sendSSE(s.sse, 'finished', { status: reason }) } catch(e){}
    try { s.sse.end() } catch(e){}
  }

  if (s.phone) {
    const mapped = activeByPhone.get(s.phone)
    if (mapped === sessionId) activeByPhone.delete(s.phone)
  }

  sessions.delete(sessionId)
}

function attachSSEToSession(id, res) {
  const sess = sessions.get(id) || {}
  sess.sse = res
  sessions.set(id, sess)
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

// Utility: read auth dir and serialize files as base64 object
async function serializeAuthDir(dir) {
  const out = {}
  try {
    const files = await fsPromises.readdir(dir)
    for (const f of files) {
      const fp = path.join(dir, f)
      const stat = await fsPromises.stat(fp)
      if (stat.isFile()) {
        const buf = await fsPromises.readFile(fp)
        out[f] = buf.toString('base64')
      }
    }
  } catch (e) {
    logger.warn({err:e}, 'serializeAuthDir failed')
  }
  return out
}

async function cleanupDir(dir) {
  try {
    await fsPromises.rm(dir, { recursive: true, force: true })
  } catch (e) {
    logger.warn({err:e}, 'cleanup failed')
  }
}

// SSE endpoint for clients to listen for session updates
app.get('/events/:id', (req, res) => {
  const { id } = req.params
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // merge with any existing session data
  attachSSEToSession(id, res)

  // send initial
  sendSSE(res, 'status', { status: 'waiting' })

  req.on('close', () => {
    const sess = sessions.get(id)
    if (sess) delete sess.sse
    try { res.end() } catch(e){}
  })
})

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// POST /qr - start a QR login flow
app.post('/qr', async (req, res) => {
  const sessionId = randomUUID()
  const authDir = path.join(__dirname, 'auth', sessionId)
  await fsPromises.mkdir(authDir, { recursive: true })

  let socket
  let resSent = false // ensure we only respond once
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir)

    socket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      // emulate desktop for more history if needed
    })

    socket.ev.on('creds.update', async (creds) => {
      await saveCreds(creds)
      const sess = sessions.get(sessionId)
      if (sess) sess.credsSaved = true
    })

    // register session for idle cleanup and SSE linking
    sessions.set(sessionId, { authDir, socket })
    startIdleTimer(sessionId)

    // Listen to connection.update for QR and status
    socket.ev.on('connection.update', async (update) => {
      // reset idle timer on any activity
      startIdleTimer(sessionId)

      const { connection, lastDisconnect, qr } = update

      const sess = sessions.get(sessionId)

      if (qr && !resSent) {
        try {
          const dataUrl = await QRCode.toDataURL(qr)
          // Send immediate response with QR data only once
          res.json({ sessionId, qr: dataUrl })
          resSent = true
          // send SSE if client connected
          if (sess && sess.sse) sendSSE(sess.sse, 'qr', { qr: dataUrl })
        } catch (e) {
          logger.warn({err:e}, 'failed generating qr dataurl')
          if (!resSent) {
            try { res.status(500).json({ error: 'failed to generate qr' }) } catch(e){}
            resSent = true
          }
        }
      }

      if (connection === 'open') {
        logger.info('connection opened')
        if (sess && sess.sse) sendSSE(sess.sse, 'status', { status: 'connected' })

        // create token from auth dir
        const filesObj = await serializeAuthDir(authDir)
        const payload = JSON.stringify({ files: filesObj })
        const token = 'SILA_' + Buffer.from(payload).toString('base64')

        // try to send token to the authenticated user's jid
        const jid = state.creds?.me?.id || null
        if (jid) {
          try {
            await socket.sendMessage(jid, { text: token })
            if (sess && sess.sse) sendSSE(sess.sse, 'status', { status: 'token_sent' })
          } catch (e) {
            logger.warn({err:e}, 'failed to send token via WA')
            if (sess && sess.sse) sendSSE(sess.sse, 'status', { status: 'token_failed', error: e?.message })
          }
        } else {
          if (sess && sess.sse) sendSSE(sess.sse, 'status', { status: 'no_jid' })
        }

        // cleanup: close socket and delete auth dir
        await finalizeSession(sessionId, 'done')
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
        logger.info({shouldReconnect}, 'connection closed')
      }
    })

  } catch (err) {
    logger.error({err}, 'QR flow failed')
    if (!res.headersSent) try { res.status(500).json({ error: 'failed to start qr session' }) } catch(e){}
    await cleanupDir(authDir)
    try { if (socket) { await socket.logout(); socket.ws.close() } } catch(e){}
  }
})

// POST /pair - pairing code flow
app.post('/pair', async (req, res) => {
  const { phoneNumber } = req.body || {}
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required in E.164 without plus' })

  // if an active session exists for this phone, clear it before creating a new one
  const existing = activeByPhone.get(phoneNumber)
  if (existing) {
    logger.info({ phoneNumber, existing }, 'clearing previous active pairing session for this phone')
    clearSession(existing)
  }

  const sessionId = randomUUID()
  const authDir = path.join(__dirname, 'auth', sessionId)
  await fsPromises.mkdir(authDir, { recursive: true })

  let socket
  let resSent = false

  // helper: wait until ws is open or timeout
  const waitForWsOpen = async (sock, timeout = 5000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (sock && sock.ws && sock.ws.readyState === 1) return true
      await new Promise(r => setTimeout(r, 200))
    }
    return false
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir)

    socket = makeWASocket({ auth: state, printQRInTerminal: false })
    socket.ev.on('creds.update', async (creds) => {
      await saveCreds(creds)
      const sess = sessions.get(sessionId)
      if (sess) sess.credsSaved = true
    })

    // register session for idle cleanup and map phone -> session
    sessions.set(sessionId, { authDir, socket, phone: phoneNumber })
    activeByPhone.set(phoneNumber, sessionId)
    startIdleTimer(sessionId)

    // request pairing code once connecting or qr event happens
    socket.ev.on('connection.update', async (update) => {
      // reset idle timer on any activity
      startIdleTimer(sessionId)

      const { connection, lastDisconnect, qr } = update
      const sess = sessions.get(sessionId)

      if ((connection === 'connecting' || qr) && !resSent) {
        // ensure ws is ready
        const ready = await waitForWsOpen(socket, 5000)
        if (!ready) {
          logger.warn('ws not ready before requesting pairing code, will attempt anyway')
        }

        // try requestPairingCode with a retry on Connection Closed
        try {
          let code
          try {
            code = await socket.requestPairingCode(phoneNumber)
          } catch (err) {
            // if connection closed, retry once after a short delay
            const msg = err?.message || ''
            if (msg.includes('Connection Closed')) {
              logger.warn('requestPairingCode failed with Connection Closed, retrying once')
              await new Promise(r => setTimeout(r, 1000))
              code = await socket.requestPairingCode(phoneNumber)
            } else throw err
          }

          if (!resSent) {
            res.json({ sessionId, pairingCode: code })
            resSent = true
          }
          if (sess && sess.sse) sendSSE(sess.sse, 'pair', { pairingCode: code })
        } catch (e) {
          logger.warn({err:e}, 'requestPairingCode failed')
          if (!resSent) {
            try { res.status(500).json({ error: 'failed request pairing code', details: e?.message }) } catch(e){}
            resSent = true
          }
        }
      }

      if (connection === 'open') {
        if (sess && sess.sse) sendSSE(sess.sse, 'status', { status: 'connected' })

        const filesObj = await serializeAuthDir(authDir)
        const payload = JSON.stringify({ files: filesObj })
        const token = 'SILA_' + Buffer.from(payload).toString('base64')

        // send token to provided phone number
        const jid = `${phoneNumber}@s.whatsapp.net`
        try {
          await socket.sendMessage(jid, { text: token })
          if (sess && sess.sse) sendSSE(sess.sse, 'status', { status: 'token_sent' })
        } catch (e) {
          logger.warn({err:e}, 'failed to send token via WA')
          if (sess && sess.sse) sendSSE(sess.sse, 'status', { status: 'token_failed', error: e?.message })
        }

        await finalizeSession(sessionId, 'done')
        // clear mappings
        sessions.delete(sessionId)
        if (activeByPhone.get(phoneNumber) === sessionId) activeByPhone.delete(phoneNumber)
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
        logger.info({shouldReconnect}, 'connection closed')
      }
    })

  } catch (err) {
    logger.error({err}, 'Pair flow failed')
    if (!res.headersSent) try { res.status(500).json({ error: 'failed to start pairing session' }) } catch(e){}
    await cleanupDir(authDir)
    try { if (socket) { await socket.logout(); socket.ws.close() } } catch(e){}
  }
})

app.listen(PORT, () => logger.info(`CODESKYTZ-MD server running on http://localhost:${PORT}`))
